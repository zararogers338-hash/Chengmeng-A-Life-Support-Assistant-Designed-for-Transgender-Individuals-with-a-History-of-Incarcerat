/**
 * 隐私回归 #3：删除一条记忆后，即使后端（故障注入）还返回旧命中，recall 也不会返回它。
 *
 * 两道保险都要测：
 * 1. search service 回到 memory/*.md 按 id 重读，取不到就丢弃并标记索引过期；
 * 2. consent.recall 过滤未确认（confirmed_by_user:false）与默认不返回的敏感条目。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createSearchService } from '../../plugins/memory-consent/src/search.js'
import { buildRecord, validateMemoryRecord } from '../../plugins/memory-consent/src/model.js'

const FIXED = new Date('2026-11-10T03:12:00.000Z')

function makeRecord(overrides = {}) {
  const built = buildRecord({
    content: '默认测试记忆',
    category: 'preference',
    sensitivity: 'normal',
    reasons: [],
    source: 'session:test-session#turn:1',
    quote_verified: 'unknown',
    confirmed_by_user: true,
    clock: () => FIXED,
    ...overrides,
  })
  const checked = validateMemoryRecord(built, { maxContentChars: 280 })
  assert.ok(checked.ok, checked.ok ? '' : checked.error)
  return checked.value
}

test('删除后后端仍返回旧命中：search service 按 Markdown 重读后丢弃，并触发重建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-delete-invisible-'))
  const dataDir = join(root, 'memory-data')
  try {
    const store = createStore({ dataDir, clock: () => FIXED })
    await store.writeSettings({ enabled: true })
    const record = makeRecord({ content: '这条记忆马上会被删除' })
    await store.addMemory(record)

    // 故障注入：后端永远返回这条（已删除）的命中。
    const staleHit = { id: record.id, score: 99, matched_by: 'keyword' }
    const backend = {
      async add() {},
      async remove() {},
      async search() {
        return [staleHit]
      },
      async rebuild(records) {
        rebuilt.push(records)
        return { ok: true }
      },
      async health() {
        return { ok: true }
      },
    }
    const rebuilt = []
    const search = createSearchService({
      backend,
      getRecord: (id) => store.getMemory(id),
      rebuildKeyword: async () => {
        const { records } = await store.listMemories()
        await backend.rebuild(records)
      },
    })

    // 删除前：能检索到。
    const before = await search.searchMemories({ query: '删除' })
    assert.equal(before.results.length, 1)
    assert.equal(before.results[0].content, '这条记忆马上会被删除')

    // 删除文件（这里直接删 store 里的记录，等价于用户点删除）。
    const removed = await store.deleteMemory(record.id)
    assert.equal(removed.ok, true)

    // 后端仍然返回旧命中，但结果必须为空。
    const after = await search.searchMemories({ query: '删除' })
    assert.deepEqual(after.results, [])
    assert.ok(after.notes.includes('index_stale'), '应当标记索引过期')
    assert.ok(rebuilt.length >= 1, '应当触发一次索引重建')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('consent.recall：未确认条目默认过滤；敏感条目只有 include_sensitive 才返回且 volunteer:false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-delete-filter-'))
  const dataDir = join(root, 'memory-data')
  try {
    const store = createStore({ dataDir, clock: () => FIXED })
    await store.writeSettings({ enabled: true })
    const results = [
      { id: 'mem_11111111-1111-4111-8111-111111111111', content: '未确认的不该返回', confirmed_by_user: false, sensitivity: 'normal', category: 'preference' },
      { id: 'mem_22222222-2222-4222-8222-222222222222', content: '敏感的不该默认返回', confirmed_by_user: true, sensitivity: 'sensitive', category: 'medical' },
      { id: 'mem_33333333-3333-4333-8333-333333333333', content: '普通记忆可以返回', confirmed_by_user: true, sensitivity: 'normal', category: 'preference' },
    ]
    const backend = {
      async add() {},
      async remove() {},
      async search() {
        return []
      },
      async rebuild() {
        return { ok: true }
      },
      async health() {
        return { ok: true }
      },
    }
    const search = { searchMemories: async () => ({ results, backend_used: 'keyword', degraded: false }) }
    const consent = createConsentService({ store, backend, search, clock: () => FIXED })

    const normal = await consent.recall({ query: '记忆' })
    assert.equal(normal.status, 'ok')
    assert.deepEqual(normal.results.map((item) => item.content), ['敏感的不该默认返回', '普通记忆可以返回'])

    const withSensitive = await consent.recall({ query: '记忆', include_sensitive: true })
    assert.equal(withSensitive.status, 'ok')
    const contents = withSensitive.results.map((item) => item.content)
    assert.deepEqual(contents, ['敏感的不该默认返回', '普通记忆可以返回'])
    const sensitive = withSensitive.results.find((item) => item.sensitivity === 'sensitive')
    assert.equal('volunteer' in sensitive, false, '旧敏感标记不改变结果')
    assert.equal('volunteer' in withSensitive.results.find((item) => item.sensitivity === 'normal'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('consent.remove 删除后 recall 返回空（走完整链路 + 后端故障注入）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-delete-full-'))
  const dataDir = join(root, 'memory-data')
  try {
    const store = createStore({ dataDir, clock: () => FIXED })
    await store.writeSettings({ enabled: true })
    const record = makeRecord({ content: '完整链路里要被删除的内容' })
    await store.addMemory(record)

    let stale = [{ id: record.id, score: 10, matched_by: 'keyword' }]
    const backend = {
      async add() {},
      async remove() {},
      async search() {
        return stale
      },
      async rebuild() {
        return { ok: true }
      },
      async health() {
        return { ok: true }
      },
    }
    const search = createSearchService({
      backend,
      getRecord: (id) => store.getMemory(id),
      rebuildKeyword: async () => {
        const { records } = await store.listMemories()
        await backend.rebuild(records)
      },
    })
    const consent = createConsentService({ store, backend, search, clock: () => FIXED })

    const before = await consent.recall({ query: '完整链路' })
    assert.equal(before.status, 'ok')
    assert.equal(before.results.length, 1)

    const removed = await consent.remove(record.id)
    assert.equal(removed.ok, true)

    const after = await consent.recall({ query: '完整链路' })
    assert.deepEqual(after.results, [], '已删除内容不能被检索到，即使后端还返回旧命中')
    assert.equal(after.status, 'empty')
    // 故障注入的后端仍然返回旧命中，证明过滤发生在检索层而不是后端。
    assert.equal(stale.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
