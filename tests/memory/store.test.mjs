/**
 * 存储层单测：原子写与故障注入、损坏文件隔离、候选 TTL、并发写、派生视图、settings、
 * 以及「只读操作不创建数据目录」。
 * 所有数据目录都是 os.tmpdir() 下的临时目录，测完删除。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as realFsp } from 'node:fs'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, createStore, localDateOf } from '../../plugins/memory-consent/src/store.js'
import { atomicWriteFile } from '../../plugins/memory-consent/src/atomic.js'
import {
  buildRecord,
  validateMemoryRecord,
  validatePendingRecord,
} from '../../plugins/memory-consent/src/model.js'
import { serializeDocument } from '../../plugins/memory-consent/src/markdown.js'

const FIXED_CLOCK = () => new Date('2026-11-10T03:12:00.000Z')
const FIXED_DATE_FILE = '2026-11-10.md'
const MAX = 280

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'chengmeng-store-'))
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 可注入的 fs 替身：默认全部转发真实实现，只覆盖需要的故障点。 */
function storeFs(overrides = {}) {
  return {
    mkdir: realFsp.mkdir.bind(realFsp),
    readFile: realFsp.readFile.bind(realFsp),
    readdir: realFsp.readdir.bind(realFsp),
    rename: realFsp.rename.bind(realFsp),
    rm: realFsp.rm.bind(realFsp),
    writeFile: realFsp.writeFile.bind(realFsp),
    stat: realFsp.stat.bind(realFsp),
    ...overrides,
  }
}

function failingRenameFs(failures = Number.POSITIVE_INFINITY) {
  let attempts = 0
  return storeFs({
    rename: async (from, to) => {
      attempts += 1
      if (attempts <= failures) {
        const error = new Error('EPERM: rename 被占用')
        error.code = 'EPERM'
        throw error
      }
      return realFsp.rename(from, to)
    },
  })
}

function buildBase(overrides = {}) {
  return buildRecord({
    content: '默认内容',
    category: 'preference',
    sensitivity: 'normal',
    reasons: [],
    source: 'session:test-session#turn:1',
    quote_verified: 'unknown',
    confirmed_by_user: true,
    clock: FIXED_CLOCK,
    ...overrides,
  })
}

function makeRecord(overrides = {}) {
  const checked = validateMemoryRecord(buildBase(overrides), { maxContentChars: MAX })
  assert.ok(checked.ok, `构造记忆失败：${checked.ok ? '' : checked.error}`)
  return checked.value
}

function makeCandidate(overrides = {}) {
  const built = buildBase({ confirmed_by_user: false, ...overrides })
  const checked = validatePendingRecord({ ...built, status: 'pending' }, { maxContentChars: MAX })
  assert.ok(checked.ok, `构造候选失败：${checked.ok ? '' : checked.error}`)
  return checked.value
}

async function listTmpFiles(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.tmp') || name.includes('.tmp.'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

test('原子写：正常写入成功，不留临时文件', async () => {
  const dir = await makeTempDir()
  try {
    const target = join(dir, 'note.txt')
    await atomicWriteFile(target, '第一版内容')
    assert.equal(await readFile(target, 'utf8'), '第一版内容')
    await atomicWriteFile(target, '第二版内容')
    assert.equal(await readFile(target, 'utf8'), '第二版内容')
    assert.deepEqual(await listTmpFiles(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('原子写故障注入：rename 失败后重试成功', async () => {
  const dir = await makeTempDir()
  try {
    const target = join(dir, 'note.txt')
    await writeFile(target, '旧内容')
    const fs = failingRenameFs(2)
    await atomicWriteFile(target, '新内容', { fs, retryDelays: [1, 1] })
    assert.equal(await readFile(target, 'utf8'), '新内容')
    assert.deepEqual(await listTmpFiles(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('原子写故障注入：rename 一直失败 → 抛错、旧文件完好、临时文件被清理', async () => {
  const dir = await makeTempDir()
  try {
    const target = join(dir, 'note.txt')
    await writeFile(target, '旧内容必须完好')
    const fs = failingRenameFs()
    await assert.rejects(() => atomicWriteFile(target, '绝不能落盘的新内容', { fs, retryDelays: [1, 1] }), /EPERM/)
    assert.equal(await readFile(target, 'utf8'), '旧内容必须完好')
    assert.deepEqual(await listTmpFiles(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('原子写故障注入：写临时文件就失败 → 抛错、旧文件完好、无临时文件', async () => {
  const dir = await makeTempDir()
  try {
    const target = join(dir, 'note.txt')
    await writeFile(target, '旧内容')
    const fs = storeFs({
      writeFile: async () => {
        const error = new Error('EIO: 磁盘错误')
        error.code = 'EIO'
        throw error
      },
    })
    await assert.rejects(() => atomicWriteFile(target, '新内容', { fs, retryDelays: [1, 1] }), /EIO/)
    assert.equal(await readFile(target, 'utf8'), '旧内容')
    assert.deepEqual(await listTmpFiles(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store 故障注入：rename 一直失败时 addMemory 抛错，旧记忆完好且无半截文件', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    const first = makeRecord({ content: '第一条旧记忆' })
    await store.addMemory(first)
    const memoryFile = join(dataDir, 'memory', FIXED_DATE_FILE)
    const before = await readFile(memoryFile, 'utf8')
    assert.match(before, /第一条旧记忆/)

    const failingStore = createStore({ dataDir, clock: FIXED_CLOCK, fs: failingRenameFs() })
    const second = makeRecord({ content: '第二条写不进去' })
    await assert.rejects(() => failingStore.addMemory(second))

    assert.equal(await readFile(memoryFile, 'utf8'), before, '旧文件内容必须完好')
    assert.deepEqual(await listTmpFiles(join(dataDir, 'memory')), [], '不能留下临时文件')
    const { records } = await store.listMemories()
    assert.equal(records.length, 1)
    assert.equal(records[0].content, '第一条旧记忆')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('坏 JSON 的 pending 文件被隔离到 index/quarantine，读取不崩溃', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    const pendingDir = join(dataDir, 'pending')
    await mkdir(pendingDir, { recursive: true })
    await writeFile(join(pendingDir, 'bad.json'), '{ 这不是合法 JSON', 'utf8')

    assert.deepEqual(await store.listPending(), [])
    const quarantineDir = join(dataDir, 'index', 'quarantine')
    const files = await readdir(quarantineDir)
    assert.ok(files.length >= 1, '坏候选应当被隔离')
    const raw = await readFile(join(quarantineDir, files[0]), 'utf8')
    assert.match(raw, /这不是合法 JSON/)
    assert.deepEqual((await readdir(pendingDir)).filter((name) => name.endsWith('.json')), [])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('坏 Markdown 块被隔离，好的记忆照常返回', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    const good = makeRecord({ content: '正常记忆内容' })
    await mkdir(join(dataDir, 'memory'), { recursive: true })
    const corrupt = '## mem_44444444-5555-4666-8777-888888888888\n\n坏块缺少围栏\n'
    await writeFile(join(dataDir, 'memory', FIXED_DATE_FILE), `${serializeDocument([good])}\n${corrupt}`, 'utf8')

    const { records, quarantined } = await store.listMemories()
    assert.equal(records.length, 1)
    assert.equal(records[0].content, '正常记忆内容')
    assert.ok(quarantined.length >= 1)
    assert.match(quarantined[0].raw, /坏块缺少围栏/)

    const quarantineFiles = await readdir(join(dataDir, 'index', 'quarantine'))
    const raws = await Promise.all(quarantineFiles.map((name) => readFile(join(dataDir, 'index', 'quarantine', name), 'utf8')))
    assert.ok(raws.some((text) => text.includes('坏块缺少围栏')))
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('候选 TTL 过期被清理，未过期时保留', async () => {
  const dataDir = await makeTempDir()
  try {
    const ref = { now: new Date('2026-11-10T03:12:00.000Z') }
    const store = createStore({ dataDir, pendingTtlHours: 24, clock: () => ref.now })
    const candidate = makeCandidate({ content: '这条候选会过期' })
    await store.addPending(candidate)

    ref.now = new Date('2026-11-11T02:12:00.000Z') // +23h
    assert.equal((await store.listPending()).length, 1)

    ref.now = new Date('2026-11-11T04:12:00.000Z') // +25h
    assert.deepEqual(await store.listPending(), [])
    assert.deepEqual((await readdir(join(dataDir, 'pending'))).filter((name) => name.endsWith('.json')), [])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('并发 addMemory：两条都落盘，没有丢失更新', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    const records = [makeRecord({ content: '并发写入的第一条' }), makeRecord({ content: '并发写入的第二条' })]
    await Promise.all(records.map((record) => store.addMemory(record)))

    const { records: saved } = await store.listMemories()
    assert.equal(saved.length, 2)
    assert.deepEqual(
      saved.map((item) => item.content).sort(),
      ['并发写入的第一条', '并发写入的第二条'],
    )
    const file = await readFile(join(dataDir, 'memory', FIXED_DATE_FILE), 'utf8')
    assert.match(file, /并发写入的第一条/)
    assert.match(file, /并发写入的第二条/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('每次变更后重新生成派生视图', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    const { record } = await store.addMemory(makeRecord({ content: '喜欢喝乌龙茶', category: 'preference' }))
    const preferences = await readFile(join(dataDir, 'views', 'preferences.md'), 'utf8')
    assert.match(preferences, /喜欢喝乌龙茶/)

    await store.deleteMemory(record.id)
    const profile = await readFile(join(dataDir, 'views', 'profile.md'), 'utf8')
    assert.doesNotMatch(profile, /喜欢喝乌龙茶/)
    assert.match(profile, /还没有记录/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('settings：默认值、读写合并、坏文件回退默认值', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    assert.deepEqual(await store.readSettings(), { ...DEFAULT_SETTINGS })
    assert.equal((await store.readSettingsState()).exists, false)

    const written = await store.writeSettings({ enabled: true })
    assert.deepEqual(written, { version: 1, enabled: true, normalMode: 'confirm' })
    assert.deepEqual(await store.readSettings(), { version: 1, enabled: true, normalMode: 'confirm' })

    const merged = await store.writeSettings({ normalMode: 'auto' })
    assert.deepEqual(merged, { version: 1, enabled: true, normalMode: 'auto' })

    await assert.rejects(() => store.writeSettings({ surprise: true }), /未知字段/)
    await assert.rejects(() => store.writeSettings({ enabled: 'yes' }), /enabled 必须是布尔值/)

    // 坏 JSON → 安全方向回退默认值（enabled=false）。
    await writeFile(join(dataDir, 'settings.json'), '{ 坏掉的 JSON', 'utf8')
    const broken = await store.readSettingsState()
    assert.equal(broken.invalid, true)
    assert.deepEqual(broken.settings, { ...DEFAULT_SETTINGS })
    assert.equal((await store.readSettings()).enabled, false)

    // 未知字段也算坏文件。
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ enabled: true, surprise: 1 }), 'utf8')
    const withUnknown = await store.readSettingsState()
    assert.equal(withUnknown.invalid, true)
    assert.equal(withUnknown.settings.enabled, false)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('只读操作不创建数据目录（new store 上读设置/候选/记忆后目录仍不存在）', async () => {
  const root = await makeTempDir()
  const dataDir = join(root, 'never-created', 'memory')
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    await store.readSettings()
    await store.readSettingsState()
    await store.listPending()
    await store.countPending()
    await store.listMemories()
    assert.equal(await store.getMemory('mem_00000000-0000-4000-8000-000000000000'), null)
    assert.equal(await pathExists(dataDir), false, '只读操作绝不能创建数据目录')
    assert.equal(await pathExists(join(root, 'never-created')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateMemoryContent：改文字、改敏感度字段并保留其余记录', async () => {
  const dataDir = await makeTempDir()
  try {
    const store = createStore({ dataDir, clock: FIXED_CLOCK })
    const { record } = await store.addMemory(makeRecord({ content: '旧文字', category: 'goal' }))
    const result = await store.updateMemoryContent(record.id, '新的文字内容', {
      edited_by_user: true,
      sensitivity: 'sensitive',
      reasons: ['medical'],
    })
    assert.equal(result.ok, true)
    assert.equal(result.record.content, '新的文字内容')
    assert.equal(result.record.sensitivity, 'sensitive')
    assert.deepEqual(result.record.reasons, ['medical'])
    assert.equal(result.record.edited_by_user, true)
    assert.equal(result.record.category, 'goal')

    const missing = await store.updateMemoryContent('mem_00000000-0000-4000-8000-000000000000', 'x')
    assert.deepEqual(missing, { ok: false, error: 'not_found' })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('localDateOf：按本地日期分文件，timeZone 可注入', async () => {
  assert.equal(localDateOf(new Date('2026-11-10T03:12:00.000Z'), 'Asia/Shanghai'), '2026-11-10')
  assert.equal(localDateOf(new Date('2026-11-10T23:30:00.000Z'), 'Asia/Shanghai'), '2026-11-11')
  assert.throws(() => localDateOf(new Date('not a date')), /合法时间/)
})
