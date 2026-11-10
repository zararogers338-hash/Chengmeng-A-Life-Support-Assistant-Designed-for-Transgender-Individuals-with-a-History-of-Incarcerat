/**
 * 集成测试：HTTP 路由（src/routes.js）。
 *
 * 覆盖：
 * - 认证：401/403 时不读请求体、业务完全不执行、响应不缓存；
 * - 带认证时逐条测 GET /status /pending /memories /export 与
 *   POST /confirm /reject /update /delete /delete-all /settings /rebuild-index；
 * - 415 / 413 / 400 / 404 / 405；响应头 no-store + nosniff；错误响应不回显用户内容。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createRouteHandler, MAX_BODY_BYTES, ROUTE_PREFIX } from '../../plugins/memory-consent/src/routes.js'

const FIXED = new Date('2026-11-10T03:12:00.000Z')
const QUOTE = '这是用户刚才亲口说过的一句话'

class BodyStream extends Readable {
  constructor(payload) {
    super()
    this.payload = payload
    this.reads = 0
  }

  _read() {
    this.reads += 1
    if (this.payload === undefined) {
      this.push(null)
      return
    }
    const chunk = this.payload
    this.payload = undefined
    this.push(chunk)
  }
}

function makeReq(method, url, { body, raw, headers = {} } = {}) {
  const payload = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined
  const req = new BodyStream(payload)
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', ...headers }
  return req
}

function fakeRes() {
  const res = { status: 0, headers: {}, body: '', headersSent: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    res.headersSent = true
  }
  res.end = (body) => {
    res.body = body === undefined ? '' : String(body)
  }
  return res
}

async function run(handler, req) {
  const res = fakeRes()
  await handler(req, res)
  return res
}

function assertNoStore(res) {
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff')
}

function proposal(overrides = {}) {
  return {
    content: '用户喜欢喝乌龙茶',
    category: 'preference',
    sensitivity_hint: 'normal',
    user_quote: QUOTE,
    stated_by_user: true,
    ...overrides,
  }
}

async function setupConsent() {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-routes-'))
  const dataDir = join(root, 'memory-data')
  const store = createStore({ dataDir, clock: () => FIXED })
  await store.writeSettings({ enabled: true, normalMode: 'confirm' })
  const rebuildCalls = []
  const backend = {
    async add() {},
    async remove() {},
    async search() {
      return []
    },
    async rebuild(records) {
      rebuildCalls.push(records)
      return { ok: true, docs: records.length }
    },
    async health() {
      return { ok: true, backend: 'keyword' }
    },
  }
  const consent = createConsentService({
    store,
    backend,
    search: { searchMemories: async () => ({ results: [], backend_used: 'keyword', degraded: false }) },
    clock: () => FIXED,
    backendName: 'keyword',
  })
  return { root, dataDir, store, backend, rebuildCalls, consent, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function makeHandler(consent, rejection = undefined) {
  return createRouteHandler({ connection: { requestRejection: () => rejection }, consent })
}

test('认证：401/403 时不读请求体、业务完全不执行、响应不缓存', async () => {
  for (const rejection of [401, 403]) {
    const businessCalls = []
    const spyConsent = new Proxy(
      {},
      {
        get: (_target, property) =>
          (..._args) => {
            businessCalls.push(property)
            throw new Error(`认证失败时不应执行业务：${String(property)}`)
          },
      },
    )
    const handler = makeHandler(spyConsent, rejection)
    const req = makeReq('POST', `${ROUTE_PREFIX}/confirm`, {
      body: { id: 'mem_11111111-1111-4111-8111-111111111111', content: '不该被读到的内容' },
    })
    const res = await run(handler, req)

    assert.equal(res.status, rejection)
    assert.equal(req.reads, 0, '被拒绝的请求体不应被读取')
    assert.deepEqual(businessCalls, [], '被拒绝的请求不应执行业务')
    assertNoStore(res)
    assert.doesNotMatch(res.body, /不该被读到的内容|mem_1111/)
    assert.equal(JSON.parse(res.body).error, rejection === 401 ? 'unauthorized' : 'forbidden')
  }
})

test('GET 路由：/status、/pending、/memories、/export', async () => {
  const env = await setupConsent()
  try {
    const handler = makeHandler(env.consent)

    let res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/status`))
    assert.equal(res.status, 200)
    assertNoStore(res)
    const status = JSON.parse(res.body)
    assert.equal(status.ok, true)
    assert.equal(status.enabled, true)
    assert.equal(status.pendingCount, 0)

    // 先造一个候选，再查 /pending。
    const proposed = await env.consent.propose(proposal(), { sessionId: 'session-a' })
    assert.equal(proposed.status, 'pending')
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/pending`))
    assert.equal(res.status, 200)
    assertNoStore(res)
    const pending = JSON.parse(res.body)
    assert.equal(pending.ok, true)
    assert.equal(pending.items.length, 1)
    assert.equal(pending.items[0].content, '用户喜欢喝乌龙茶')
    assert.equal('reasons' in pending.items[0], false)

    // 确认后查 /memories。
    const confirmed = await env.consent.confirm(proposed.id)
    assert.equal(confirmed.ok, true)
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/memories`))
    assert.equal(res.status, 200)
    assertNoStore(res)
    const memories = JSON.parse(res.body)
    assert.equal(memories.ok, true)
    assert.equal(memories.items.length, 1)
    assert.equal(memories.items[0].content, '用户喜欢喝乌龙茶')

    // 类别过滤。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/memories?category=preference`))
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).items.length, 1)
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/memories?category=goal`))
    assert.equal(JSON.parse(res.body).items.length, 0)

    // 导出：不带 format 同时含 markdown 与 memories。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export`))
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.match(res.headers['Content-Type'], /application\/json/)
    assert.match(res.headers['Content-Disposition'], /attachment/)
    const exported = JSON.parse(res.body)
    assert.equal(exported.ok, true)
    assert.match(exported.markdown, /用户喜欢喝乌龙茶/)
    assert.equal(exported.memories.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('POST 路由：/confirm、/reject、/update、/delete、/settings、/rebuild-index、/delete-all', async () => {
  const env = await setupConsent()
  try {
    const handler = makeHandler(env.consent)

    // confirm
    const first = await env.consent.propose(proposal({ content: '确认这条内容' }), { sessionId: 'session-a' })
    let res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/confirm`, { body: { id: first.id } }))
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.equal(JSON.parse(res.body).item.content, '确认这条内容')
    assert.equal(await env.store.getPending(first.id), null)

    // reject
    const second = await env.consent.propose(proposal({ content: '拒绝这条内容' }), { sessionId: 'session-a' })
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/reject`, { body: { id: second.id } }))
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.equal(JSON.parse(res.body).removed, true)
    assert.equal(await env.store.getPending(second.id), null)

    // update
    const third = await env.consent.propose(proposal({ content: '修改前的内容' }), { sessionId: 'session-a' })
    const confirmedThird = await env.consent.confirm(third.id)
    res = await run(
      handler,
      makeReq('POST', `${ROUTE_PREFIX}/update`, {
        body: { id: confirmedThird.record.id, content: '修改后的内容' },
      }),
    )
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.equal(JSON.parse(res.body).item.content, '修改后的内容')

    // delete
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/delete`, { body: { id: confirmedThird.record.id } }))
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.equal(await env.store.getMemory(confirmedThird.record.id), null)

    // settings
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/settings`, { body: { normalMode: 'auto' } }))
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.equal(JSON.parse(res.body).settings.normalMode, 'auto')

    // rebuild-index（POST 统一要求 JSON 对象请求体）
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/rebuild-index`, { body: {} }))
    assert.equal(res.status, 200)
    assertNoStore(res)
    const rebuilt = JSON.parse(res.body)
    assert.equal(rebuilt.ok, true)
    assert.equal(rebuilt.backend, 'keyword')
    assert.equal(typeof rebuilt.rebuilt, 'number')
    assert.ok(env.rebuildCalls.length >= 1)

    // delete-all：确认字符串必须是 'DELETE'
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/delete-all`, { body: { confirm: 'delete' } }))
    assert.equal(res.status, 400)
    assertNoStore(res)
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/delete-all`, { body: {} }))
    assert.equal(res.status, 400)
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/delete-all`, { body: { confirm: 'DELETE' } }))
    assert.equal(res.status, 200)
    assertNoStore(res)
    assert.deepEqual((await env.store.listMemories()).records, [])
  } finally {
    await env.cleanup()
  }
})

test('错误路径：415 / 413 / 400 / 404 / 405，响应头正确且不回显用户内容', async () => {
  const env = await setupConsent()
  try {
    const handler = makeHandler(env.consent)

    // 415：请求体不是 application/json。
    let res = await run(
      handler,
      makeReq('POST', `${ROUTE_PREFIX}/settings`, { raw: '{}', headers: { 'content-type': 'text/plain' } }),
    )
    assert.equal(res.status, 415)
    assertNoStore(res)

    // 413：请求体超过 16 KB。
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/settings`, { raw: 'x'.repeat(MAX_BODY_BYTES + 1) }))
    assert.equal(res.status, 413)
    assertNoStore(res)

    // 400：坏 JSON。
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/settings`, { raw: 'not json' }))
    assert.equal(res.status, 400)
    assertNoStore(res)

    // 400：请求体不是对象。
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/settings`, { body: [] }))
    assert.equal(res.status, 400)
    assertNoStore(res)

    // 400：非法 id。
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/confirm`, { body: { id: '' } }))
    assert.equal(res.status, 400)
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/delete`, { body: { id: 'x'.repeat(200) } }))
    assert.equal(res.status, 400)
    assertNoStore(res)

    // 400：确认时改出的密钥内容被拒绝，且响应不回显内容。
    const pending = await env.consent.propose(proposal({ content: '普通待确认内容' }), { sessionId: 'session-a' })
    res = await run(
      handler,
      makeReq('POST', `${ROUTE_PREFIX}/confirm`, {
        body: { id: pending.id, content: 'password: hunter2secret' },
      }),
    )
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).error, 'contains_secret')
    assert.doesNotMatch(res.body, /hunter2secret/)
    assertNoStore(res)

    // 400：非法查询参数。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/memories?category=bogus`))
    assert.equal(res.status, 400)
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/memories?since=not-a-date`))
    assert.equal(res.status, 400)
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export?format=xml`))
    assert.equal(res.status, 400)
    assertNoStore(res)

    // 404：未知路由、非本模块前缀。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/nope`))
    assert.equal(res.status, 404)
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/nope`, { body: {} }))
    assert.equal(res.status, 404)
    res = await run(handler, makeReq('GET', '/other-module/status'))
    assert.equal(res.status, 404)
    assertNoStore(res)

    // 405：GET 路由不接受其它方法。
    res = await run(handler, makeReq('PUT', `${ROUTE_PREFIX}/status`, { body: {} }))
    assert.equal(res.status, 405)
    assertNoStore(res)
  } finally {
    await env.cleanup()
  }
})
