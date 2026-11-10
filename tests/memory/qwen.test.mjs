import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createQwenBackend } from '../../plugins/memory-consent/src/backends/qwen.js'
import { createQwenEncoder } from '../../plugins/memory-consent/src/backends/qwen-encoder.js'
import { createHybridBackend } from '../../plugins/memory-consent/src/backends/hybrid.js'
import { validateConfig } from '../../plugins/memory-consent/src/config.js'
import { buildRecord, validateMemoryRecord } from '../../plugins/memory-consent/src/model.js'
import { serializeDocument, parseDocument } from '../../plugins/memory-consent/src/markdown.js'
import { resolvePeriod, timelinePage } from '../../plugins/memory-consent/src/time-range.js'
import { createQuoteVerifier } from '../../plugins/memory-consent/src/quotes.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createStore } from '../../plugins/memory-consent/src/store.js'

const makeRecord = (content, extra = {}) => ({ ...buildRecord({ content, category: 'preference',
  sensitivity: 'normal', reasons: [], source: 'session:fixture#turn:1', quote_verified: true,
  confirmed_by_user: true, clock: () => new Date('2026-11-10T01:00:00.000Z') }), ...extra })
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cm-qwen-unit-'))
  t.after(async () => {
    assert.equal(dirname(dataDir), tmpdir()); assert(basename(dataDir).startsWith('cm-qwen-unit-'))
    await rm(dataDir, { recursive: true, force: true })
  })
  const config = { ...validateConfig({}).qwen, dimensions: 32, modelDir: join(dataDir, 'model'), minScore: 0.5 }
  let records = [], fail = false
  const calls = []
  const encoder = {
    health: async () => ({ ok: !fail, configured: !fail, device: 'cpu' }), dispose() {},
    encode: async (texts, options) => {
      if (fail) throw new Error('synthetic model failure')
      calls.push({ texts, kind: options.kind })
      return texts.map(text => Array.from({ length: 32 }, (_, i) => i === (text.includes('茶') ? 0 : 1) ? 1 : 0))
    },
  }
  const backend = createQwenBackend({ dataDir, config, encoder, getRecords: async () => records })
  return { backend, config, calls, dataDir, encoder, setRecords: list => { records = list }, fail: () => { fail = true } }
}

test('Qwen：首次建索引后只计算查询；重启可复用向量，不保存正文', async t => {
  const env = await setup(t)
  const tea = makeRecord('喜欢喝茶'), bird = makeRecord('喜欢观鸟')
  env.setRecords([tea, bird])
  assert.equal((await env.backend.search('下午茶'))[0].id, tea.id)
  const docCalls = env.calls.filter(x => x.kind === 'document').length
  await env.backend.search('茶')
  assert.equal(env.calls.filter(x => x.kind === 'document').length, docCalls)
  const raw = await readFile(join(env.dataDir, 'index/qwen-vectors.json'), 'utf8')
  assert(!raw.includes('喜欢喝茶'))
  const restored = createQwenBackend({ dataDir: env.dataDir, config: env.config, encoder: env.encoder, getRecords: async () => [tea, bird] })
  assert.equal((await restored.search('茶'))[0].id, tea.id)
  assert.equal(env.calls.filter(x => x.kind === 'document').length, docCalls)
})

test('Qwen：修改重算，源删除清向量，模型失效时删除仍可完成', async t => {
  const env = await setup(t)
  const record = makeRecord('喜欢喝茶')
  env.setRecords([record]); await env.backend.search('茶')
  env.setRecords([{ ...record, content: '喜欢观鸟' }]); await env.backend.search('观鸟')
  assert.equal(env.calls.filter(x => x.kind === 'document').length, 2)
  env.fail(); await env.backend.remove(record.id)
  const index = JSON.parse(await readFile(join(env.dataDir, 'index/qwen-vectors.json'), 'utf8'))
  assert.equal(index.rows.length, 0)
})

test('Qwen：切回关键词模式后，删除仍清理旧向量缓存', async t => {
  const env = await setup(t)
  const store = createStore({ dataDir: env.dataDir })
  const record = makeRecord('待删除的虚构记忆')
  await store.addMemory(record)
  const path = join(env.dataDir, 'index/qwen-vectors.json')
  await writeFile(path, JSON.stringify({ stale: record.id }))
  assert.equal((await store.deleteMemory(record.id)).ok, true)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('Qwen：未确认记录永不入索引，敏感和时间条件在 top-k 前过滤', async t => {
  const env = await setup(t)
  const privateRecord = makeRecord('喝茶的私人事项', { sensitivity: 'sensitive' })
  const publicRecord = makeRecord('喜欢喝茶', { source_time: '2026-11-03T01:00:00.000Z' })
  const pending = makeRecord('候选喝茶', { confirmed_by_user: false })
  env.setRecords([privateRecord, publicRecord, pending])
  const result = await env.backend.search('茶', { includeSensitive: false, limit: 1,
    since: '2026-11-02T00:00:00.000Z', until: '2026-11-08T23:59:59.999Z' })
  assert.deepEqual(result.map(x => x.id), [publicRecord.id])
  assert.equal(env.calls.some(x => x.texts.includes('候选喝茶')), false)
  await assert.rejects(env.backend.add(pending), /UNCONFIRMED_MEMORY/)
})

test('Qwen：模型缺失立即降级关键词，不创建推理进程', async t => {
  const env = await setup(t)
  const encoder = createQwenEncoder({ ...env.config, python: '', modelDir: '' }, { spawnImpl: () => { throw new Error('must not spawn') } })
  const qwen = createQwenBackend({ dataDir: env.dataDir, config: env.config, encoder, getRecords: async () => [] })
  const hybrid = createHybridBackend({ keyword: { search: async () => [{ id: 'fixture', score: 1 }] }, memsearch: qwen })
  const result = await hybrid.search('茶')
  assert.equal(result.backend_used, 'keyword'); assert.equal(result.degraded, true)
  assert.equal(result.results[0].id, 'fixture')
  encoder.dispose()
})

test('Qwen：配置严格校验，模型路径可缺省以便无模型机器继续运行', () => {
  assert.equal(validateConfig({ backend: 'qwen-hybrid' }).qwen.python, '')
  for (const qwen of [{ dimensions: 1 }, { threads: 0 }, { modelDir: 'relative' }, { gpu: true }, { minScore: 2 }]) {
    assert.throws(() => validateConfig({ qwen }), /INVALID_QWEN/)
  }
})

test('Qwen：降级后没有命中也明确告诉模型只做了关键词检索', async () => {
  const consent = createConsentService({ store: { readSettings: async () => ({ enabled: true }) }, backend: {},
    search: { searchMemories: async () => ({ results: [], degraded: true, backend_used: 'keyword' }) } })
  const result = await consent.recall({ query: '换一种说法' })
  assert.equal(result.status, 'empty'); assert.match(result.message, /仅用关键词/)
})

test('Qwen：低内存不启动；推理超时终止工作进程并退回关键词', async t => {
  const env = await setup(t)
  const python = join(env.dataDir, 'fake-python')
  await mkdir(env.config.modelDir)
  await Promise.all([python, ...['model.safetensors', 'config.json', 'tokenizer.json'].map(n => join(env.config.modelDir, n))].map(n => writeFile(n, 'fixture')))
  const config = { ...env.config, python, timeoutMs: 100 }
  const low = createQwenEncoder(config, { freeMemory: () => 1, spawnImpl: () => { throw new Error('must not start') } })
  await assert.rejects(low.encode(['fixture']), /QWEN_LOW_MEMORY/)
  assert.equal((await low.health()).reason, 'insufficient_memory')
  low.dispose()
  let stopped = false
  const worker = new EventEmitter()
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => {}
  worker.stderr = new EventEmitter()
  worker.stdin = new EventEmitter(); worker.stdin.write = () => {}; worker.stdin.destroy = () => {}
  worker.kill = () => { stopped = true }
  const hanging = createQwenEncoder(config, { freeMemory: () => 16 * 1024 ** 3, spawnImpl: () => worker })
  const record = makeRecord('测试记忆')
  const qwen = createQwenBackend({ dataDir: env.dataDir, config, encoder: hanging, getRecords: async () => [record] })
  const result = await createHybridBackend({ keyword: { search: async () => [{ id: record.id, score: 1 }] }, memsearch: qwen }).search('测试')
  assert.equal(result.backend_used, 'keyword'); assert.equal(result.degraded, true); assert(stopped)
  hanging.dispose()
})

test('时间回顾：上周按上海日历计算；纽约跨夏令时仍有准确边界', () => {
  assert.deepEqual(resolvePeriod('last_week', new Date('2026-11-10T01:00:00Z'), 'Asia/Shanghai'), {
    since: '2026-11-01T16:00:00.000Z', until: '2026-11-08T15:59:59.999Z', time_zone: 'Asia/Shanghai',
  })
  const dst = resolvePeriod('last_week', new Date('2026-11-03T12:00:00Z'), 'America/New_York')
  assert.equal(Date.parse(dst.until) + 1 - Date.parse(dst.since), 169 * 3600000)
})

test('时间回顾：超过一页完整列出，旧敏感标记不排除，修改后旧游标失效', () => {
  const records = Array.from({ length: 13 }, (_, i) => makeRecord(`虚构事项 ${i}`, { source_time: '2026-11-03T00:00:00.000Z' }))
  records.push(makeRecord('私人事项', { sensitivity: 'sensitive', source_time: '2026-11-03T00:00:00.000Z' }))
  const options = { ...resolvePeriod('last_week', new Date('2026-11-10T01:00:00Z')), limit: 5, includeSensitive: false }
  const first = timelinePage(records, options), second = timelinePage(records, { ...options, cursor: first.next_cursor }),
    third = timelinePage(records, { ...options, cursor: second.next_cursor })
  assert.equal(first.total, 14); assert.equal(first.has_more, true); assert.equal(third.has_more, false)
  assert.equal(new Set([...first.results, ...second.results, ...third.results].map(x => x.id)).size, 14)
  records[0].content = '已变化'
  assert.equal(timelinePage(records, { ...options, cursor: first.next_cursor }).status, 'stale_cursor')
})

test('时间回顾：旧数据标明保存时间替代，长内容分页避免被宿主工具裁剪', () => {
  const records = Array.from({ length: 3 }, () => makeRecord('字'.repeat(4000)))
  const page = timelinePage(records, { limit: 8, includeSensitive: false })
  assert.equal(page.results.length, 1); assert.equal(page.has_more, true)
  assert.equal(page.results[0].time_basis, 'memory_created_fallback')
})

test('时间回顾：源文件读取失败返回稳定错误，不泄露内部路径', async () => {
  const consent = createConsentService({ store: { readSettings: async () => ({ enabled: true }),
    listMemories: async () => { throw new Error('private/internal/path') } }, backend: {}, search: {} })
  const result = await consent.recall({ mode: 'timeline', period: 'last_week' })
  assert.equal(result.status, 'error'); assert.doesNotMatch(result.message, /private|path/)
})

test('来源时间：原始引文时间入库，旧 Markdown 可继续读取', async () => {
  const verify = createQuoteVerifier({ includeSourceTime: true, getSessionQuery: () => ({
    filterEvents: async () => [{ seq: 1, time: Date.parse('2026-11-03T02:00:00Z') }],
  }) })
  const verified = await verify({ sessionId: 'fixture', quote: '虚构原话' })
  assert.equal(verified.sourceTime, '2026-11-03T02:00:00.000Z')
  const old = makeRecord('旧记忆'), current = makeRecord('新记忆', { source_time: verified.sourceTime })
  for (const record of [old, current]) {
    assert.deepEqual(parseDocument(serializeDocument([record])).records[0], record)
    assert.equal(validateMemoryRecord(record, { maxContentChars: 280 }).ok, true)
  }
})
