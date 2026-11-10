/**
 * 混合检索（RRF 融合 + 降级）测试。全部虚构数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  createHybridBackend,
  reciprocalRankFusion,
  SEARCH_UNAVAILABLE,
} from '../../plugins/memory-consent/src/backends/hybrid.js'

let idCounter = 0
/** 稳定、可读的假 id（不用于真实记录）。 */
function fakeId(label) {
  idCounter += 1
  return `mem_${label}_${idCounter}`
}

function makeRecord() {
  return {
    id: `mem_${randomUUID()}`,
    content: '下周二有一场面试',
    category: 'episode',
    created_at: '2026-11-10T03:12:00.000Z',
  }
}

/**
 * 假后端：记录所有调用；可以指定返回的命中列表、以及让哪些方法失败。
 * hits 为数组或 (query, options) => 数组。
 */
function createStubBackend({ name, hits = [], failOn = [], healthResult = { ok: true } } = {}) {
  const failures = new Set(failOn)
  const calls = { search: [], add: [], remove: [], rebuild: [], health: 0 }
  return {
    name,
    calls,
    async search(query, options) {
      calls.search.push({ query, options })
      if (failures.has('search')) throw new Error(`${name} 检索失败`)
      return Array.isArray(hits) ? hits : hits(query, options)
    },
    async add(record) {
      calls.add.push(record)
      if (failures.has('add')) throw new Error(`${name} add 失败`)
    },
    async remove(id) {
      calls.remove.push(id)
      if (failures.has('remove')) throw new Error(`${name} remove 失败`)
    },
    async rebuild(records) {
      calls.rebuild.push(records)
      if (failures.has('rebuild')) throw new Error(`${name} rebuild 失败`)
    },
    async health() {
      calls.health += 1
      if (failures.has('health')) throw new Error(`${name} health 失败`)
      return healthResult
    },
    async isIndexed() {
      return true
    },
  }
}

const approx = (actual, expected) => Math.abs(actual - expected) < 1e-12

test('RRF：同 id 分数相加、按总分排序、matched_by 取排名更靠前的列表', () => {
  const a = fakeId('a')
  const b = fakeId('b')
  const c = fakeId('c')
  const d = fakeId('d')
  const fused = reciprocalRankFusion([
    { backend: 'keyword', items: [{ id: a }, { id: b }, { id: c }] },
    { backend: 'semantic', items: [{ id: b }, { id: c }, { id: d }] },
  ])
  assert.deepEqual(fused.map((item) => item.id), [b, c, a, d])
  const byId = new Map(fused.map((item) => [item.id, item]))
  assert.ok(approx(byId.get(b).score, 1 / 61 + 1 / 62))
  assert.ok(approx(byId.get(c).score, 1 / 62 + 1 / 63))
  assert.ok(approx(byId.get(a).score, 1 / 61))
  // d 在 semantic 列表里排第 2（0 起算）→ 1/(60 + 2 + 1)。
  assert.ok(approx(byId.get(d).score, 1 / 63))
  // b 在 semantic 里排第 0、keyword 里排第 1 → 取 semantic；c 同理。
  assert.equal(byId.get(b).matched_by, 'semantic')
  assert.equal(byId.get(c).matched_by, 'semantic')
  assert.equal(byId.get(a).matched_by, 'keyword')
  assert.equal(byId.get(d).matched_by, 'semantic')
})

test('RRF：同一列表里的重复 id 只算一次；同排名并列时 matched_by 为 semantic', () => {
  const x = fakeId('x')
  const duplicated = reciprocalRankFusion([{ backend: 'keyword', items: [{ id: x }, { id: x }, { id: x }] }])
  assert.equal(duplicated.length, 1)
  assert.ok(approx(duplicated[0].score, 1 / 61))

  const tie = reciprocalRankFusion([
    { backend: 'keyword', items: [{ id: x }] },
    { backend: 'semantic', items: [{ id: x }] },
  ])
  assert.equal(tie[0].matched_by, 'semantic')
  assert.ok(approx(tie[0].score, 2 / 61))

  // 交叉排名：x 在 keyword 排 0、semantic 排 1 → keyword；y 相反 → semantic。
  const y = fakeId('y')
  const crossed = reciprocalRankFusion([
    { backend: 'keyword', items: [{ id: x }, { id: y }] },
    { backend: 'semantic', items: [{ id: y }, { id: x }] },
  ])
  const crossedById = new Map(crossed.map((item) => [item.id, item]))
  assert.equal(crossedById.get(x).matched_by, 'keyword')
  assert.equal(crossedById.get(y).matched_by, 'semantic')
})

test('RRF：k 与 limit 参数生效；空输入返回空数组；非法输入报错', () => {
  const a = fakeId('a')
  const b = fakeId('b')
  const c = fakeId('c')
  const fused = reciprocalRankFusion([{ backend: 'keyword', items: [{ id: a }, { id: b }, { id: c }] }], { k: 0 })
  assert.deepEqual(fused.map((item) => item.id), [a, b, c])
  assert.deepEqual(fused.map((item) => item.score), [1, 1 / 2, 1 / 3])
  assert.deepEqual(reciprocalRankFusion([{ backend: 'keyword', items: [{ id: a }, { id: b }] }], { limit: 1 }).map((item) => item.id), [a])
  assert.deepEqual(reciprocalRankFusion([]), [])
  assert.throws(() => reciprocalRankFusion(null), TypeError)
})

test('semantic 失败 → 降级为 keyword（degraded=true，backend_used=keyword）', async () => {
  const hits = [
    { id: fakeId('k1'), score: 9, matched_by: 'keyword' },
    { id: fakeId('k2'), score: 5, matched_by: 'keyword' },
    { id: fakeId('k3'), score: 1, matched_by: 'keyword' },
  ]
  const keyword = createStubBackend({ name: 'keyword', hits })
  const memsearch = createStubBackend({ name: 'memsearch', failOn: ['search'] })
  const hybrid = createHybridBackend({ keyword, memsearch })

  const outcome = await hybrid.search('面试', { limit: 5 })
  assert.equal(outcome.backend_used, 'keyword')
  assert.equal(outcome.degraded, true)
  assert.equal(outcome.degraded_reason, 'semantic_failed')
  assert.deepEqual(outcome.results.map((item) => item.id), hits.map((hit) => hit.id))
  assert.ok(outcome.results.every((item) => item.matched_by === 'keyword'))
  // 降级不把失败后端的错误信息带出去。
  assert.equal(JSON.stringify(outcome).includes('检索失败'), false)
})

test('keyword 失败 → 降级为 semantic（degraded=true，degraded_reason=keyword_failed）', async () => {
  const first = fakeId('s1')
  const second = fakeId('s2')
  const keyword = createStubBackend({ name: 'keyword', failOn: ['search'] })
  const memsearch = createStubBackend({
    name: 'memsearch',
    hits: [
      { id: first, score: 0.9, matched_by: 'semantic' },
      { id: second, score: 0.8, matched_by: 'semantic' },
    ],
  })
  const hybrid = createHybridBackend({ keyword, memsearch })
  const outcome = await hybrid.search('面试')
  assert.equal(outcome.backend_used, 'semantic')
  assert.equal(outcome.degraded, true)
  assert.equal(outcome.degraded_reason, 'keyword_failed')
  assert.deepEqual(outcome.results.map((item) => item.id), [first, second])
  assert.ok(outcome.results.every((item) => item.matched_by === 'semantic'))
})

test('两个后端都失败 → 抛稳定 code SEARCH_UNAVAILABLE，且不泄露查询原文', async () => {
  const keyword = createStubBackend({ name: 'keyword', failOn: ['search'] })
  const memsearch = createStubBackend({ name: 'memsearch', failOn: ['search'] })
  const hybrid = createHybridBackend({ keyword, memsearch })
  await assert.rejects(hybrid.search('面试的秘密'), (error) => {
    assert.equal(error.code, SEARCH_UNAVAILABLE)
    assert.equal(error.message, 'SEARCH_UNAVAILABLE')
    assert.ok(!error.message.includes('面试的秘密'))
    return true
  })
})

test('未配置 memsearch（null）时等于纯关键词模式：不降级', async () => {
  const hits = [{ id: fakeId('k'), score: 3, matched_by: 'keyword' }]
  const keyword = createStubBackend({ name: 'keyword', hits })
  const hybrid = createHybridBackend({ keyword })
  const outcome = await hybrid.search('面试')
  assert.equal(outcome.backend_used, 'keyword')
  assert.equal(outcome.degraded, false)
  assert.equal(outcome.degraded_reason, undefined)
  assert.deepEqual(outcome.results.map((item) => item.id), [hits[0].id])
})

test('两个后端都成功 → backend_used=hybrid，结果按 RRF 融合', async () => {
  const a = fakeId('a')
  const b = fakeId('b')
  const c = fakeId('c')
  const keyword = createStubBackend({
    name: 'keyword',
    hits: [
      { id: a, score: 9, matched_by: 'keyword' },
      { id: b, score: 5, matched_by: 'keyword' },
    ],
  })
  const memsearch = createStubBackend({
    name: 'memsearch',
    hits: [
      { id: b, score: 0.9, matched_by: 'semantic' },
      { id: c, score: 0.8, matched_by: 'semantic' },
    ],
  })
  const hybrid = createHybridBackend({ keyword, memsearch })
  // b: keyword 第 1 + semantic 第 0（最高分）；a: keyword 第 0；c: semantic 第 1。
  const outcome = await hybrid.search('面试')
  assert.equal(outcome.backend_used, 'hybrid')
  assert.equal(outcome.degraded, false)
  assert.equal(outcome.degraded_reason, undefined)
  assert.deepEqual(outcome.results.map((item) => item.id), [b, a, c])
  assert.equal(outcome.results[0].matched_by, 'semantic')
})

test('相对阈值：低于 best × minScoreRatio 的结果被过滤', async () => {
  // 单后端：默认 k = 60 时分数很平，把阈值提到 0.99 才能稳定只留第一名。
  const hits = [
    { id: fakeId('h1'), score: 9, matched_by: 'keyword' },
    { id: fakeId('h2'), score: 8, matched_by: 'keyword' },
    { id: fakeId('h3'), score: 7, matched_by: 'keyword' },
    { id: fakeId('h4'), score: 6, matched_by: 'keyword' },
    { id: fakeId('h5'), score: 5, matched_by: 'keyword' },
  ]
  const keywordOnly = createHybridBackend({
    keyword: createStubBackend({ name: 'keyword', hits }),
    minScoreRatio: 0.99,
  })
  const strict = await keywordOnly.search('面试')
  assert.deepEqual(strict.results.map((item) => item.id), [hits[0].id])

  // 双列表：只出现一次且名次靠后的结果会被 0.6 的阈值过滤掉。
  const shared = fakeId('shared')
  const tail = fakeId('tail')
  const dual = createHybridBackend({
    keyword: createStubBackend({
      name: 'keyword',
      hits: [
        { id: shared, score: 9, matched_by: 'keyword' },
        { id: tail, score: 1, matched_by: 'keyword' },
      ],
    }),
    memsearch: createStubBackend({
      name: 'memsearch',
      hits: [
        { id: shared, score: 0.9, matched_by: 'semantic' },
        { id: fakeId('other'), score: 0.8, matched_by: 'semantic' },
      ],
    }),
    minScoreRatio: 0.6,
  })
  const filtered = await dual.search('面试')
  assert.equal(filtered.results.some((item) => item.id === tail), false)
  assert.equal(filtered.results[0].id, shared)
})

test('limit 只截断结果；空查询返回空结果不抛错', async () => {
  const hits = [
    { id: fakeId('l1'), score: 9, matched_by: 'keyword' },
    { id: fakeId('l2'), score: 5, matched_by: 'keyword' },
    { id: fakeId('l3'), score: 1, matched_by: 'keyword' },
  ]
  const hybrid = createHybridBackend({ keyword: createStubBackend({ name: 'keyword', hits }) })
  const outcome = await hybrid.search('面试', { limit: 2 })
  assert.deepEqual(outcome.results.map((item) => item.id), [hits[0].id, hits[1].id])
  const empty = await hybrid.search('')
  assert.deepEqual(empty.results, [])
  assert.equal(empty.degraded, false)
})

test('health 汇总两个后端；任一不可用则 ok=false，semantic 不可用标记降级', async () => {
  const healthy = await createHybridBackend({
    keyword: createStubBackend({ name: 'keyword', healthResult: { ok: true, docs: 3 } }),
    memsearch: createStubBackend({ name: 'memsearch', healthResult: { ok: true } }),
  }).health()
  assert.equal(healthy.ok, true)
  assert.equal(healthy.degraded, false)
  assert.equal(healthy.backends.keyword.docs, 3)

  const degraded = await createHybridBackend({
    keyword: createStubBackend({ name: 'keyword', healthResult: { ok: true } }),
    memsearch: createStubBackend({ name: 'memsearch', healthResult: { ok: false, reason: 'command_unavailable' } }),
  }).health()
  assert.equal(degraded.ok, false)
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.reason, 'backend_unavailable')

  // health 抛错也要被兜住，不能把内部信息带出去。
  const broken = await createHybridBackend({
    keyword: createStubBackend({ name: 'keyword', failOn: ['health'] }),
    memsearch: null,
  }).health()
  assert.equal(broken.ok, false)
  assert.equal(broken.backends.keyword.reason, 'health_failed')
})

test('add / remove / rebuild 分发给所有后端；单个后端失败不阻断另一个、不向上抛', async () => {
  const keyword = createStubBackend({ name: 'keyword' })
  const memsearch = createStubBackend({ name: 'memsearch', failOn: ['add', 'remove', 'rebuild'] })
  const hybrid = createHybridBackend({ keyword, memsearch })
  const record = makeRecord()
  await hybrid.add(record)
  await hybrid.remove(record.id)
  await hybrid.rebuild([record])
  assert.equal(keyword.calls.add.length, 1)
  assert.equal(keyword.calls.remove.length, 1)
  assert.equal(keyword.calls.rebuild.length, 1)
  assert.equal(memsearch.calls.add.length, 1)
  assert.equal(memsearch.calls.remove.length, 1)
  assert.equal(memsearch.calls.rebuild.length, 1)
})

test('signal 已中止时 search 抛 AbortError，不调用后端', async () => {
  const keyword = createStubBackend({ name: 'keyword' })
  const hybrid = createHybridBackend({ keyword })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(hybrid.search('面试', { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.equal(keyword.calls.search.length, 0)
})
