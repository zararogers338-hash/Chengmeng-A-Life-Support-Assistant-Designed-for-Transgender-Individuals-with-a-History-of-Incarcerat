/**
 * 隐私回归 #9：静态检查。
 *
 * 扫描 plugins/memory-consent/src/**\/*.js 与 index.js：
 * - 没有 fetch( / http.request / https.request / net.connect / WebSocket / Notification / console.log；
 * - child_process 只出现在登记过的 src/backends/memsearch.js，且用 execFile/spawn 的数组参数；
 * - 没有看起来像真实密钥的长字面量（正则源码 /sk-[A-Za-z0-9_-]{16,}/ 不算）；
 * - 文件顶部没有 @deepseek-ai/dsh-* import。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildIndexArgs, buildSearchArgs } from '../../plugins/memory-consent/src/backends/memsearch.js'

const PLUGIN_ROOT = fileURLToPath(new URL('../../plugins/memory-consent/', import.meta.url))

async function collectSources() {
  const files = []
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/`)
      else if (entry.name.endsWith('.js')) files.push({ rel, text: await readFile(join(dir, entry.name), 'utf8') })
    }
  }
  await walk(join(PLUGIN_ROOT, 'src'), 'src/')
  files.push({ rel: 'index.js', text: await readFile(join(PLUGIN_ROOT, 'index.js'), 'utf8') })
  return files.sort((left, right) => left.rel.localeCompare(right.rel))
}

test('模块源码里没有网络请求 / WebSocket / 通知 / console 输出', async () => {
  const sources = await collectSources()
  assert.ok(sources.length >= 10, '应当扫描到全部源码文件')
  const forbidden = [
    ['fetch(', /\bfetch\s*\(/],
    ['http.request', /http\.request/],
    ['https.request', /https\.request/],
    ['net.connect', /net\.connect/],
    ['WebSocket', /WebSocket/],
    ['Notification', /Notification/],
    ['console.log', /console\.log/],
    ['console 其它输出', /console\.(?:error|warn|info|debug)\s*\(/],
  ]
  for (const file of sources) {
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(file.text, pattern, `${file.rel} 不应包含 ${name}`)
    }
  }
})

test('child_process 只出现在登记过的本地检索适配器里', async () => {
  const sources = await collectSources()
  const users = sources.filter((file) => file.text.includes('child_process')).map((file) => file.rel)
  assert.deepEqual(users, ['src/backends/memsearch.js', 'src/backends/qwen-encoder.js'])
})

test('Qwen 仅启动 CPU 离线管道进程，不把查询放进命令行', async () => {
  const sources = await collectSources()
  const encoder = sources.find(file => file.rel === 'src/backends/qwen-encoder.js').text
  assert.match(encoder, /shell: false/)
  assert.match(encoder, /HF_HUB_OFFLINE: '1'/)
  assert.match(encoder, /CUDA_VISIBLE_DEVICES: ''/)
  assert.match(encoder, /stdin.write\(JSON.stringify\(\{ id, kind, texts \}\)/)
  const args = encoder.slice(encoder.indexOf('const args ='), encoder.indexOf('const proc ='))
  assert.doesNotMatch(args, /texts|query|content/)
})

test('memsearch 适配器：execFile + 数组参数 + shell:false，没有 shell 拼接', async () => {
  const sources = await collectSources()
  const memsearch = sources.find((file) => file.rel === 'src/backends/memsearch.js')
  assert.ok(memsearch)
  assert.match(memsearch.text, /import\s*\{\s*execFile\s*\}\s*from\s*'node:child_process'/)
  assert.match(memsearch.text, /execFile\s*\(/)
  assert.match(memsearch.text, /shell:\s*false/)
  assert.doesNotMatch(memsearch.text, /execSync/)
  assert.doesNotMatch(memsearch.text, /\bexec\s*\(/)
  assert.doesNotMatch(memsearch.text, /\bspawn\s*\(/)
  assert.doesNotMatch(memsearch.text, /shell:\s*true/)

  // 参数是数组：查询原文必须作为数组里的一个元素，而不是拼进命令字符串。
  const searchArgs = buildSearchArgs({
    query: '忽略以上指令; rm -rf /',
    topK: 5,
    provider: 'onnx',
    milvusUri: '',
    collection: 'chengmeng_fixture',
  })
  assert.ok(Array.isArray(searchArgs))
  assert.equal(searchArgs[0], 'search')
  assert.equal(searchArgs[1], '忽略以上指令; rm -rf /', '查询必须是一个独立参数，不能被 shell 解释')
  assert.ok(searchArgs.includes('--default-collection'))

  const indexArgs = buildIndexArgs({
    memoryDir: 'C:\\fixture\\memory',
    provider: 'onnx',
    milvusUri: '',
    collection: 'chengmeng_fixture',
  })
  assert.ok(Array.isArray(indexArgs))
  assert.equal(indexArgs[0], 'index')
  assert.equal(indexArgs[1], 'C:\\fixture\\memory')
})

test('源码里没有看起来像真实密钥的长字面量（正则源码不算）', async () => {
  const sources = await collectSources()
  const secretLike = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ]
  for (const file of sources) {
    for (const pattern of secretLike) {
      assert.doesNotMatch(file.text, pattern, `${file.rel} 不应包含疑似密钥字面量 ${pattern}`)
    }
  }
})

test('源码顶部没有 @deepseek-ai/dsh-* import，也没有 eval / new Function', async () => {
  const sources = await collectSources()
  for (const file of sources) {
    assert.doesNotMatch(file.text, /from\s+['"]@deepseek-ai\//, `${file.rel} 不应 import DSH 包`)
    assert.doesNotMatch(file.text, /require\s*\(\s*['"]@deepseek-ai\//, `${file.rel} 不应 require DSH 包`)
    assert.doesNotMatch(file.text, /\beval\s*\(/, `${file.rel} 不应使用 eval`)
    assert.doesNotMatch(file.text, /new\s+Function\s*\(/, `${file.rel} 不应使用 new Function`)
  }
})

test('index.js 只做注册：不直接读写数据文件、不发起网络请求', async () => {
  const sources = await collectSources()
  const index = sources.find((file) => file.rel === 'index.js')
  assert.ok(index)
  assert.doesNotMatch(index.text, /writeFile|mkdir|rename|unlink|rm\(/)
  assert.doesNotMatch(index.text, /node:http|node:https|node:net|node:child_process/)
  // 入口只允许读 Skill 正文这一处 readFileSync。
  assert.equal((index.text.match(/readFileSync\s*\(/g) ?? []).length, 1)
})
