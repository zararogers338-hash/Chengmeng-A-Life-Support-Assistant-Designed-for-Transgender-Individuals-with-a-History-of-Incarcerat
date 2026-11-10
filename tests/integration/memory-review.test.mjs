import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createSearchService } from '../../plugins/memory-consent/src/search.js'
import { createKeywordBackend } from '../../plugins/memory-consent/src/backends/keyword.js'
import { createMemoryApi } from '../../plugins/memory-consent/client/api.js'

const clock = () => new Date('2026-11-10T02:00:00Z')
const proposal = (content, quote = content) => ({ content, user_quote: quote, category: 'preference', stated_by_user: true })

async function setup(t, { auto = false, brokenSearch = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'cm-integration-review-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert(basename(root).startsWith('cm-integration-review-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  let denyRead = false
  const io = { ...fs, readFile: (path, ...args) => {
    if (denyRead && String(path).endsWith('.md')) throw Object.assign(new Error('synthetic read denial'), { code: 'EACCES' })
    return fs.readFile(path, ...args)
  } }
  const dataDir = join(root, 'memory-data')
  const store = createStore({ dataDir, clock, fs: io })
  await store.writeSettings({ enabled: true, normalMode: auto ? 'auto' : 'confirm' })
  const backend = createKeywordBackend({ dataDir })
  const search = createSearchService({ backend: brokenSearch ? { search: async () => { throw new Error('synthetic failure') } } : backend,
    getRecord: id => store.getMemory(id) })
  const consent = createConsentService({ store, backend, search, clock, verifyQuote: async () => true })
  return { store, consent, failReads: () => { denyRead = true } }
}

test('自动整理：允许忠实概括，保存自动来源，不冒充逐条人工确认', async t => {
  const { store, consent } = await setup(t, { auto: true })
  const result = await consent.propose(proposal('喜欢海边散步', '我喜欢在海边散步'), { sessionId: 'review-a' })
  assert.equal(result.status, 'saved')
  const records=(await store.listMemories()).records
  assert.equal(records.length, 1)
  assert.equal(records[0].confirmed_by_user,false)
  assert.equal(records[0].saved_automatically,true)
})

test('审查回归：相同候选并发确认不得重复落盘', async t => {
  const { store, consent } = await setup(t)
  const { id } = await consent.propose(proposal('用户喜欢海边散步'), { sessionId: 'review-a' })
  await Promise.all([consent.confirm(id), consent.confirm(id)])
  const stored = await store.listMemories()
  assert.equal(stored.records.length, 1)
  assert.equal(stored.quarantined.length, 0, 'duplicate blocks must not be hidden in quarantine')
})

test('审查回归：关闭开关后旧卡片不能继续确认新记忆', async t => {
  const { store, consent } = await setup(t)
  const { id } = await consent.propose(proposal('用户喜欢海边散步'), { sessionId: 'review-a' })
  await consent.updateSettings({ enabled: false })
  assert.deepEqual(await consent.confirm(id), { ok: false, error: 'disabled' })
  assert.equal((await store.listMemories()).records.length, 0)
})

test('审查回归：后端故障必须报不可用，不能冒充没有相关记忆', async t => {
  const { consent } = await setup(t, { brokenSearch: true })
  const result = await consent.recall({ query: '散步' })
  assert.equal(result.status, 'error')
  assert.match(result.message, /不可用/)
})

test('审查回归：管理界面的私人搜索词只放请求体', async () => {
  const requests = []
  const api = createMemoryApi(async (url, init) => {
    requests.push({ url, init })
    return { ok: true, json: async () => ({ ok: true, items: [] }) }
  })
  await api.memories({ q: '虚构私人查询', category: 'preference' })
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].url, '/chengmeng-memory/memories/search')
  assert.equal(JSON.parse(requests[0].init.body).q, '虚构私人查询')
})

test('审查回归：候选按来源会话过滤，不在其他聊天中弹出', async t => {
  const { consent } = await setup(t)
  await consent.propose(proposal('用户喜欢海边散步'), { sessionId: 'review-a' })
  await consent.propose(proposal('用户喜欢看星星'), { sessionId: 'review-b' })
  const result = await consent.listPendingForUi({ sessionId: 'review-b' })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].content, '用户喜欢看星星')
})

test('审查回归：管理界面拒绝时也使用候选原始会话的去重范围', async t => {
  const { consent } = await setup(t)
  const p = proposal('用户喜欢海边散步')
  const { id } = await consent.propose(p, { sessionId: 'review-a' })
  await consent.reject(id)
  assert.equal((await consent.propose(p, { sessionId: 'review-a' })).status, 'duplicate')
})

test('审查回归：源文件读取失败不能被当成空数据库', async t => {
  const { consent, store, failReads } = await setup(t)
  const { id } = await consent.propose(proposal('用户喜欢海边散步'), { sessionId: 'review-a' })
  await consent.confirm(id)
  failReads()
  await assert.rejects(store.listMemories(), { code: 'EACCES' })
})
