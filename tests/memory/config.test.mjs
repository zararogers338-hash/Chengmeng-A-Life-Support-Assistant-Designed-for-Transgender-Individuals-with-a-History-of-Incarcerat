/**
 * 配置校验单测：默认值、严格校验、dataDir 解析（全部用注入的 env / home，不读真实环境）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, normalize } from 'node:path'

import {
  BACKENDS,
  DEFAULT_CONFIG,
  DATA_SUBDIR,
  expandTilde,
  resolveDataDir,
  validateConfig,
} from '../../plugins/memory-consent/src/config.js'

const FAKE_HOME = normalize(join('C:', 'Users', 'fixture-home'))

test('默认值：空配置得到完整默认值', () => {
  const config = validateConfig({})
  assert.equal(config.dataDir, '')
  assert.equal(config.backend, 'keyword')
  assert.deepEqual(config.memsearch, { command: '', provider: 'onnx', milvusUri: '', timeoutMs: 8000 })
  assert.equal(config.pendingTtlHours, 24)
  assert.equal(config.maxContentChars, 280)
  assert.deepEqual(validateConfig(undefined), validateConfig({}))
})

test('未知字段直接报错（顶层与 memsearch 嵌套）', () => {
  assert.throws(() => validateConfig({ surprise: true }), /未知配置项 surprise/)
  assert.throws(() => validateConfig({ dataDir: '', extra: 1 }), /未知配置项 extra/)
  assert.throws(() => validateConfig({ memsearch: { nope: 1 } }), /未知配置项 memsearch\.nope/)
})

test('类型错误直接报错', () => {
  assert.throws(() => validateConfig(42), /config 必须是对象/)
  assert.throws(() => validateConfig('config'), /config 必须是对象/)
  assert.throws(() => validateConfig([]), /config 必须是对象/)
  assert.throws(() => validateConfig({ dataDir: 42 }), /dataDir 必须是字符串/)
  assert.throws(() => validateConfig({ memsearch: 'nope' }), /memsearch 必须是对象/)
  assert.throws(() => validateConfig({ memsearch: { command: 42 } }), /memsearch\.command 必须是字符串/)
  assert.throws(() => validateConfig({ memsearch: { provider: '' } }), /memsearch\.provider 必须是非空字符串/)
  assert.throws(() => validateConfig({ memsearch: { milvusUri: 1 } }), /milvusUri 必须是字符串/)
  assert.throws(() => validateConfig({ pendingTtlHours: '24' }), /pendingTtlHours 必须是/)
  assert.throws(() => validateConfig({ maxContentChars: '280' }), /maxContentChars 必须是/)
})

test('枚举与范围越界直接报错', () => {
  assert.throws(() => validateConfig({ backend: 'bogus' }), /backend 只能是 keyword \| memsearch \| hybrid/)
  for (const backend of BACKENDS) assert.equal(validateConfig({ backend }).backend, backend)

  assert.throws(() => validateConfig({ memsearch: { timeoutMs: 99 } }), /timeoutMs 必须是 100–60000/)
  assert.throws(() => validateConfig({ memsearch: { timeoutMs: 60001 } }), /timeoutMs 必须是 100–60000/)
  assert.throws(() => validateConfig({ memsearch: { timeoutMs: 1.5 } }), /timeoutMs 必须是 100–60000/)

  assert.throws(() => validateConfig({ pendingTtlHours: 0 }), /pendingTtlHours 必须是大于 0 的有限数/)
  assert.throws(() => validateConfig({ pendingTtlHours: -1 }), /pendingTtlHours 必须是大于 0 的有限数/)
  assert.throws(() => validateConfig({ pendingTtlHours: 24 * 366 }), /pendingTtlHours 必须是大于 0 的有限数/)

  assert.throws(() => validateConfig({ maxContentChars: 0 }), /maxContentChars 必须是 1–4000/)
  assert.throws(() => validateConfig({ maxContentChars: 4001 }), /maxContentChars 必须是 1–4000/)
  assert.throws(() => validateConfig({ maxContentChars: 1.5 }), /maxContentChars 必须是 1–4000/)
})

test('合法自定义值被原样保留', () => {
  const config = validateConfig({
    dataDir: 'C:\\fixture\\memory-data',
    backend: 'hybrid',
    memsearch: { command: 'C:\\venv\\memsearch.exe', provider: 'onnx', milvusUri: 'http://127.0.0.1:19530', timeoutMs: 5000 },
    pendingTtlHours: 12,
    maxContentChars: 500,
  })
  assert.equal(config.backend, 'hybrid')
  assert.equal(config.memsearch.timeoutMs, 5000)
  assert.equal(config.pendingTtlHours, 12)
  assert.equal(config.maxContentChars, 500)
})

test('dataDir 为空 → <DSH_HOME>/chengmeng/memory（注入 env/home）', () => {
  const dshHome = normalize(join('C:', 'fixture', 'dsh-home'))
  const resolved = resolveDataDir(validateConfig({}), { env: { DSH_HOME: dshHome }, home: FAKE_HOME })
  assert.equal(resolved, normalize(join(dshHome, ...DATA_SUBDIR)))
  assert.ok(resolved.endsWith(normalize(join('chengmeng', 'memory'))))
})

test('DSH_HOME 空白字符串视为未设置 → <home>/.dsh/chengmeng/memory', () => {
  const expected = normalize(join(FAKE_HOME, '.dsh', ...DATA_SUBDIR))
  for (const DSH_HOME of ['', '   ', '\t']) {
    assert.equal(resolveDataDir(validateConfig({}), { env: { DSH_HOME }, home: FAKE_HOME }), expected)
  }
  // 环境变量完全缺失也一样（不传 DSH_HOME 键）。
  assert.equal(resolveDataDir(validateConfig({}), { env: {}, home: FAKE_HOME }), expected)
})

test('不同 DSH_HOME 解析出不同数据目录', () => {
  const homeA = normalize(join('C:', 'fixture', 'home-a'))
  const homeB = normalize(join('C:', 'fixture', 'home-b'))
  const pathA = resolveDataDir(validateConfig({}), { env: { DSH_HOME: homeA }, home: FAKE_HOME })
  const pathB = resolveDataDir(validateConfig({}), { env: { DSH_HOME: homeB }, home: FAKE_HOME })
  assert.notEqual(pathA, pathB)
  assert.equal(pathA, normalize(join(homeA, ...DATA_SUBDIR)))
  assert.equal(pathB, normalize(join(homeB, ...DATA_SUBDIR)))
})

test('相对 dataDir 被拒绝；绝对路径与 ~ 路径被接受', () => {
  const config = (dataDir) => validateConfig({ dataDir })

  assert.throws(() => resolveDataDir(config('relative/dir'), { env: {}, home: FAKE_HOME }), /必须是绝对路径/)
  assert.throws(() => resolveDataDir(config('./relative'), { env: {}, home: FAKE_HOME }), /必须是绝对路径/)
  assert.throws(() => resolveDataDir(config('..'), { env: {}, home: FAKE_HOME }), /必须是绝对路径/)

  const absolute = normalize(join('C:', 'fixture', 'absolute-data'))
  assert.equal(resolveDataDir(config(absolute), { env: {}, home: FAKE_HOME }), absolute)

  assert.equal(resolveDataDir(config('~'), { env: {}, home: FAKE_HOME }), normalize(FAKE_HOME))
  assert.equal(
    resolveDataDir(config('~/memory'), { env: {}, home: FAKE_HOME }),
    normalize(join(FAKE_HOME, 'memory')),
  )
})

test('显式 dataDir 优先于 DSH_HOME', () => {
  const explicit = normalize(join('C:', 'fixture', 'explicit'))
  const resolved = resolveDataDir(validateConfig({ dataDir: explicit }), {
    env: { DSH_HOME: normalize(join('C:', 'fixture', 'dsh-home')) },
    home: FAKE_HOME,
  })
  assert.equal(resolved, explicit)
})

test('expandTilde 只展开开头的 ~，其余原样返回', () => {
  assert.equal(expandTilde('~', FAKE_HOME), normalize(FAKE_HOME))
  assert.equal(expandTilde('~/a/b', FAKE_HOME), normalize(join(FAKE_HOME, 'a', 'b')))
  assert.equal(expandTilde('C:\\a\\~\\b', FAKE_HOME), 'C:\\a\\~\\b')
  assert.equal(expandTilde('mid~tilde', FAKE_HOME), 'mid~tilde')
})
