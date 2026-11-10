/**
 * 集成测试：导出。
 * 走完整流程 propose → confirm → GET /export，断言：
 * - 导出 Markdown 与 memory/*.md 完全一致；
 * - ?format=md 是 text/markdown 附件，?format=json 是 JSON 附件；
 * - 不带 format 同时含 markdown 与 memories；
 * - 未确认的候选不会出现在任何导出里；导出同样要认证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createRouteHandler, ROUTE_PREFIX } from '../../plugins/memory-consent/src/routes.js'
import { parseDocument } from '../../plugins/memory-consent/src/markdown.js'

const FIXED = new Date('2026-11-10T03:12:00.000Z')
const QUOTE = '这是用户刚才亲口说过的一句话'

function makeReq(method, url, { body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json' }
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
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-export-'))
  const dataDir = join(root, 'memory-data')
  const clockRef = { now: FIXED }
  const store = createStore({ dataDir, clock: () => clockRef.now })
  await store.writeSettings({ enabled: true, normalMode: 'confirm' })
  const backend = {
    async add() {},
    async remove() {},
    async search() {
      return []
    },
    async rebuild(records) {
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
    clock: () => clockRef.now,
    backendName: 'keyword',
  })
  return {
    root,
    dataDir,
    store,
    consent,
    clockRef,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('完整流程：propose → confirm → export，导出 Markdown 与 memory/*.md 完全一致', async () => {
  const env = await setupConsent()
  try {
    const handler = createRouteHandler({
      connection: { requestRejection: () => undefined },
      consent: env.consent,
    })

    // 通过工具层同款 consent.propose 提议，再通过路由确认（完整流程）。
    const first = await env.consent.propose(proposal({ content: '导出流程的第一条记忆' }), { sessionId: 's1' })
    assert.equal(first.status, 'pending')
    let res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/confirm`, { body: { id: first.id } }))
    assert.equal(res.status, 200)

    // 让第二条的时间戳晚一点，保证「文件追加顺序 = 导出排序」可以逐字节比较。
    env.clockRef.now = new Date('2026-11-10T04:00:00.000Z')
    const second = await env.consent.propose(
      proposal({ content: '导出流程的第二条记忆', category: 'goal' }),
      { sessionId: 's1' },
    )
    res = await run(handler, makeReq('POST', `${ROUTE_PREFIX}/confirm`, { body: { id: second.id } }))
    assert.equal(res.status, 200)

    // 未确认的候选：绝不能出现在导出里。
    await env.consent.propose(proposal({ content: '未确认的候选不能出现在导出里' }), { sessionId: 's1' })

    // 事实来源：memory/*.md。
    const memoryDir = join(env.dataDir, 'memory')
    const memoryFiles = (await readdir(memoryDir)).filter((name) => name.endsWith('.md')).sort()
    assert.equal(memoryFiles.length, 1, '同一天的确认应当写进同一个文件')
    const fileText = await readFile(join(memoryDir, memoryFiles[0]), 'utf8')
    assert.match(fileText, /导出流程的第一条记忆/)
    assert.match(fileText, /导出流程的第二条记忆/)

    // format=md：text/markdown 附件，内容与 memory/*.md 完全一致。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export?format=md`))
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /^text\/markdown/)
    assert.match(res.headers['Content-Disposition'], /attachment/)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.equal(res.body, fileText, '导出的 Markdown 必须与事实来源逐字节一致')
    assert.doesNotMatch(res.body, /未确认的候选不能出现在导出里/)

    // format=json：JSON 附件，memories 与已确认记忆一致。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export?format=json`))
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /^application\/json/)
    assert.match(res.headers['Content-Disposition'], /attachment/)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    const jsonExport = JSON.parse(res.body)
    assert.equal(jsonExport.memories.length, 2)
    assert.deepEqual(
      jsonExport.memories.map((item) => item.content).sort(),
      ['导出流程的第一条记忆', '导出流程的第二条记忆'],
    )
    assert.equal('markdown' in jsonExport, false)
    assert.doesNotMatch(res.body, /未确认的候选不能出现在导出里/)

    // 不带 format：同时含 markdown 与 memories。
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export`))
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /^application\/json/)
    assert.match(res.headers['Content-Disposition'], /attachment/)
    const both = JSON.parse(res.body)
    assert.equal(both.ok, true)
    assert.equal(both.markdown, fileText)
    assert.equal(both.memories.length, 2)

    // 导出内容与 store 里的记录一致。
    const { records } = await env.store.listMemories()
    const parsed = parseDocument(both.markdown, { maxContentChars: 280 })
    assert.equal(parsed.quarantined.length, 0)
    assert.deepEqual(parsed.records, records)
  } finally {
    await env.cleanup()
  }
})

test('导出仍然要认证：401 时不返回任何数据', async () => {
  const env = await setupConsent()
  try {
    const first = await env.consent.propose(proposal({ content: '认证保护的导出内容' }), { sessionId: 's1' })
    await env.consent.confirm(first.id)

    const handler = createRouteHandler({
      connection: { requestRejection: () => 401 },
      consent: env.consent,
    })
    for (const url of [`${ROUTE_PREFIX}/export`, `${ROUTE_PREFIX}/export?format=md`, `${ROUTE_PREFIX}/export?format=json`]) {
      const res = await run(handler, makeReq('GET', url))
      assert.equal(res.status, 401)
      assert.doesNotMatch(res.body, /认证保护的导出内容/)
      assert.equal(res.headers['Cache-Control'], 'no-store')
    }
  } finally {
    await env.cleanup()
  }
})

test('没有记忆时导出：Markdown 为空、JSON memories 为空数组', async () => {
  const env = await setupConsent()
  try {
    const handler = createRouteHandler({
      connection: { requestRejection: () => undefined },
      consent: env.consent,
    })
    let res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export?format=md`))
    assert.equal(res.status, 200)
    assert.equal(res.body, '')
    res = await run(handler, makeReq('GET', `${ROUTE_PREFIX}/export?format=json`))
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body).memories, [])
  } finally {
    await env.cleanup()
  }
})
