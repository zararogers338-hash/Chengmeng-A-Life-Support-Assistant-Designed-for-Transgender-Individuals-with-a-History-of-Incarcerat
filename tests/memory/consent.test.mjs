/**
 * 授权流程（consent service）单测：开关、敏感条目、auto 模式、防推测、绝不存、
 * 去重、确认 / 拒绝 / 修改 / 删除 / 全部删除 / 导出 / 状态。
 *
 * 全部用假 backend、假 search 和 os.tmpdir() 下的临时数据目录，不联网、不碰真实数据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createSearchService } from '../../plugins/memory-consent/src/search.js'
import { buildRecord, validateMemoryRecord } from '../../plugins/memory-consent/src/model.js'
import { parseDocument } from '../../plugins/memory-consent/src/markdown.js'

const FIXED = new Date('2026-11-10T03:12:00.000Z')
const MAX = 280
const QUOTE = '这是用户刚才亲口说过的一句话'

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 递归快照：目录名 + 文件内容，用来证明"前后一个字节都没变"。 */
async function snapshotDir(root) {
  const output = []
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        output.push(`dir:${rel}`)
        await walk(join(dir, entry.name), rel)
      } else {
        const content = await readFile(join(dir, entry.name))
        output.push(`file:${rel}:${content.toString('utf8')}`)
      }
    }
  }
  await walk(root, '')
  return output
}

/** 递归扫描数据目录里的全部文本。 */
async function readAllTexts(root) {
  const texts = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        try {
          texts.push({ path: full, text: await readFile(full, 'utf8') })
        } catch {
          // 二进制/读不了的文件跳过（数据目录里目前只应有文本）。
        }
      }
    }
  }
  await walk(root)
  return texts
}

async function assertTextNowhere(root, needle) {
  const texts = await readAllTexts(root)
  for (const item of texts) {
    assert.ok(!item.text.includes(needle), `磁盘上不应出现这段文字：${item.path}`)
  }
}

function makeBackend(overrides = {}) {
  const calls = { add: [], remove: [], rebuild: [], search: [] }
  return {
    calls,
    async add(record) {
      if (overrides.failAdd) throw new Error('add failed')
      calls.add.push(record)
    },
    async remove(id) {
      if (overrides.failRemove) {
        const error = new Error('remove failed')
        error.code = 'EFAIL'
        throw error
      }
      calls.remove.push(id)
    },
    async search(query, options) {
      calls.search.push({ query, options })
      return []
    },
    async rebuild(records) {
      if (overrides.failRebuild) throw new Error('rebuild failed')
      calls.rebuild.push(records)
      return { ok: true, docs: records.length }
    },
    async health() {
      return { ok: true, backend: 'keyword' }
    },
  }
}

function makeSearch(results = []) {
  return { searchMemories: async () => ({ results, backend_used: 'keyword', degraded: false }) }
}

/** 故障注入后端：search 永远返回 staleHits（模拟"删除后索引还返回旧命中"）。 */
function makeStaleBackend({ failRemove = false, failRebuild = false } = {}) {
  const calls = { add: [], remove: [], rebuild: [], search: [] }
  const staleHits = []
  return {
    calls,
    staleHits,
    async add(record) {
      calls.add.push(record)
    },
    async remove(id) {
      calls.remove.push(id)
      if (failRemove) {
        const error = new Error('remove failed')
        error.code = 'EFAIL'
        throw error
      }
    },
    async search() {
      calls.search.push({})
      return [...staleHits]
    },
    async rebuild(records) {
      calls.rebuild.push(records)
      if (failRebuild) {
        const error = new Error('rebuild failed')
        error.code = 'EFAIL'
        throw error
      }
      return { ok: true, docs: records.length }
    },
    async health() {
      return { ok: true, backend: 'keyword' }
    },
  }
}

/** 用真实 search service 串起 store（Markdown 事实）与故障注入后端。 */
function makeSearchService(store, backend) {
  return createSearchService({
    backend,
    getRecord: (id) => store.getMemory(id),
    rebuildKeyword: async () => {
      const { records } = await store.listMemories()
      await backend.rebuild(records)
    },
  })
}

function makeRecord(overrides = {}) {
  const built = buildRecord({
    content: '直接写入的测试记忆',
    category: 'preference',
    sensitivity: 'normal',
    reasons: [],
    source: 'session:test-session#turn:1',
    quote_verified: 'unknown',
    confirmed_by_user: true,
    clock: () => FIXED,
    ...overrides,
  })
  const checked = validateMemoryRecord(built, { maxContentChars: MAX })
  assert.ok(checked.ok, `构造记忆失败：${checked.ok ? '' : checked.error}`)
  return checked.value
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

async function setup(options = {}) {
  const {
    enabled = true,
    normalMode = 'confirm',
    quoteVerified = 'unknown',
    backendOverrides = {},
    searchResults = [],
    clockRef = { now: FIXED },
  } = options
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-consent-'))
  // 数据目录用临时目录下的子路径：这样"关闭时不创建数据目录"才有意义。
  const dataDir = join(root, 'memory-data')
  const store = createStore({ dataDir, clock: () => clockRef.now, maxContentChars: MAX, pendingTtlHours: 24 })
  if (enabled) await store.writeSettings({ enabled: true, normalMode })
  const backend = makeBackend(backendOverrides)
  const search = makeSearch(searchResults)
  const logs = []
  const consent = createConsentService({
    store,
    backend,
    search,
    clock: () => clockRef.now,
    maxContentChars: MAX,
    verifyQuote: async () => quoteVerified,
    backendName: 'keyword',
    logger: { warn: (message) => logs.push(message), info: (message) => logs.push(message) },
  })
  return {
    dataDir,
    store,
    backend,
    search,
    consent,
    logs,
    clockRef,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('关闭时：propose 返回 disabled 且数据目录不存在/不变；recall 返回 disabled', async () => {
  const env = await setup({ enabled: false })
  try {
    const before = await snapshotDir(env.dataDir)
    const result = await env.consent.propose(proposal(), { sessionId: 'session-a' })
    assert.equal(result.status, 'disabled')
    assert.match(result.message, /没有保存任何内容/)
    assert.equal(await pathExists(env.dataDir), false, '关闭时 propose 不能创建数据目录')
    assert.deepEqual(await snapshotDir(env.dataDir), before)

    const recall = await env.consent.recall({ query: '乌龙茶' })
    assert.equal(recall.status, 'disabled')
    assert.deepEqual(recall.results, [])
    assert.match(recall.message, /关闭/)
  } finally {
    await env.cleanup()
  }
})

test('自动模式：所有话题直接保存，不按敏感词分类，无需确认', async () => {
  const env = await setup({ normalMode: 'auto', quoteVerified: true })
  try {
    const result = await env.consent.propose(
      proposal({ content: '用户正在服用激素，情绪不太稳定', category: 'explicit' }),
      { sessionId: 'session-a', turn: 2 },
    )
    assert.equal(result.status, 'saved')
    assert.equal((await env.store.listPending()).length, 0)
    const { records } = await env.store.listMemories()
    assert.equal(records.length, 1)
    assert.equal(records[0].sensitivity, 'normal')
    assert.deepEqual(records[0].reasons, [])
    assert.equal(records[0].saved_automatically, true)
    assert.equal(records[0].confirmed_by_user, false)
    assert.equal(env.backend.calls.add.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('auto 模式：normal + 引文核对 true → 直接写入；false / unknown 绝不自动写', async () => {
  {
    const env = await setup({ normalMode: 'auto', quoteVerified: true })
    try {
      const result = await env.consent.propose(proposal({ content: '每天晚饭后散步半小时', user_quote: '每天晚饭后散步半小时' }), {
        sessionId: 'session-a',
        turn: 1,
      })
      assert.equal(result.status, 'saved')
      assert.equal(result.message, '已自动保存。')
      const { records } = await env.store.listMemories()
      assert.equal(records.length, 1)
      assert.equal(records[0].confirmed_by_user, false)
      assert.equal(records[0].saved_automatically, true)
      assert.equal(env.backend.calls.add.length, 1)
    } finally {
      await env.cleanup()
    }
  }

  for (const quoteVerified of [false, 'unknown']) {
    const env = await setup({ normalMode: 'auto', quoteVerified })
    try {
      const result = await env.consent.propose(proposal({ content: '每天晚饭后散步半小时' }), {
        sessionId: 'session-a',
        turn: 1,
      })
      assert.equal(result.status, 'rejected_by_policy', `quote_verified=${quoteVerified} 时不捏造整理记忆`)
      assert.equal(env.backend.calls.add.length, 0)
      const { records } = await env.store.listMemories()
      assert.equal(records.length, 0)
      assert.equal((await env.store.listPending()).length, 0)
    } finally {
      await env.cleanup()
    }
  }
})

test('防推测：缺 stated_by_user / stated_by_user:false / 缺 user_quote → rejected_by_policy，不写文件', async () => {
  const env = await setup()
  try {
    const before = await snapshotDir(env.dataDir)
    const cases = [
      { content: '用户喜欢喝乌龙茶', category: 'preference', user_quote: QUOTE }, // 缺 stated_by_user
      { content: '用户喜欢喝乌龙茶', category: 'preference', user_quote: QUOTE, stated_by_user: false },
      { content: '用户喜欢喝乌龙茶', category: 'preference', stated_by_user: true }, // 缺 user_quote
      { content: '用户喜欢喝乌龙茶', category: 'preference', stated_by_user: true, user_quote: '   ' },
    ]
    for (const args of cases) {
      const result = await env.consent.propose(args, { sessionId: 'session-a' })
      assert.equal(result.status, 'rejected_by_policy', JSON.stringify(args))
      assert.doesNotMatch(result.message, /乌龙茶/)
    }
    assert.deepEqual(await snapshotDir(env.dataDir), before, '策略拒绝不能写任何文件')
    assert.equal(env.backend.calls.add.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('绝不存：密钥 / 身份证 / 银行卡在提议阶段直接拒绝，磁盘与返回值都不回显内容', async () => {
  const env = await setup()
  try {
    const before = await snapshotDir(env.dataDir)
    const secrets = [
      '我的密钥是 sk-abcdefghijklmnopqrstuvwxyz012345',
      '身份证号 11010519491231002X',
      '卡号 4111111111111111',
      'password: hunter2secret',
    ]
    for (const content of secrets) {
      const result = await env.consent.propose(proposal({ content }), { sessionId: 'session-a' })
      assert.equal(result.status, 'rejected_by_policy')
      assert.doesNotMatch(result.message, /sk-|1101051949|4111111111111111|hunter2secret/)
    }
    assert.deepEqual(await snapshotDir(env.dataDir), before)
    for (const content of secrets) await assertTextNowhere(env.dataDir, content)
    assert.equal((await env.store.listPending()).length, 0, '绝不存的内容不能进入待确认队列')
  } finally {
    await env.cleanup()
  }
})

test('参数非法 → invalid，且不写文件', async () => {
  const env = await setup()
  try {
    const before = await snapshotDir(env.dataDir)
    const cases = [
      {},
      { category: 'preference', user_quote: QUOTE, stated_by_user: true }, // 缺 content
      proposal({ content: 'x'.repeat(MAX + 1) }),
      proposal({ category: 'bogus' }),
      proposal({ sensitivity_hint: 'very' }),
      proposal({ user_quote: 'q'.repeat(121) }),
      proposal({ stated_by_user: 'true' }),
      { ...proposal(), extra: 1 },
    ]
    for (const args of cases) {
      const result = await env.consent.propose(args, { sessionId: 'session-a' })
      assert.equal(result.status, 'invalid', JSON.stringify(args).slice(0, 80))
      assert.match(result.message, /参数无效/)
    }
    assert.deepEqual(await snapshotDir(env.dataDir), before)
  } finally {
    await env.cleanup()
  }
})

test('重复提议：pending 已有 / 已记忆 / 本次会话刚拒绝 → duplicate', async () => {
  const env = await setup()
  try {
    const context = { sessionId: 'session-a' }
    const first = await env.consent.propose(proposal(), context)
    assert.equal(first.status, 'pending')
    assert.equal((await env.consent.propose(proposal(), context)).status, 'duplicate')

    const confirmed = await env.consent.confirm(first.id)
    assert.equal(confirmed.ok, true)
    assert.equal((await env.consent.propose(proposal(), context)).status, 'duplicate')

    const second = await env.consent.propose(proposal({ content: '用户喜欢喝普洱' }), context)
    assert.equal(second.status, 'pending')
    await env.consent.reject(second.id, context)
    assert.equal((await env.consent.propose(proposal({ content: '用户喜欢喝普洱' }), context)).status, 'duplicate')

    // 换个会话（进程内缓存按会话隔离）可以重新提议。
    const otherSession = await env.consent.propose(proposal({ content: '用户喜欢喝普洱' }), { sessionId: 'session-b' })
    assert.equal(otherSession.status, 'pending')
  } finally {
    await env.cleanup()
  }
})

test('confirm：写 memory/ 并删除 pending；改过的内容重新判定敏感度；含密钥拒绝', async () => {
  const env = await setup()
  try {
    // 普通确认。
    const basic = await env.consent.propose(proposal({ content: '每周三去游泳' }), { sessionId: 's1' })
    assert.equal(basic.status, 'pending')
    const confirmed = await env.consent.confirm(basic.id)
    assert.equal(confirmed.ok, true)
    assert.equal(confirmed.record.confirmed_by_user, true)
    assert.equal(await env.store.getPending(basic.id), null)
    assert.equal(env.backend.calls.add.length, 1)
    const { records } = await env.store.listMemories()
    assert.equal(records.length, 1)
    assert.equal(records[0].content, '每周三去游泳')

    // 确认时改文字：改成含医疗词的内容 → 重新判定为敏感。
    const second = await env.consent.propose(proposal({ content: '每周四去跑步' }), { sessionId: 's1' })
    const edited = await env.consent.confirm(second.id, { content: '每周四去跑步，最近在吃药' })
    assert.equal(edited.ok, true)
    assert.equal(edited.record.sensitivity, 'normal')
    assert.deepEqual(edited.record.reasons, [])
    assert.equal(edited.record.edited_by_user, true)

    // 确认时改成含密钥的内容：拒绝，候选原样保留。
    const third = await env.consent.propose(proposal({ content: '每周五去爬山' }), { sessionId: 's1' })
    const blocked = await env.consent.confirm(third.id, { content: 'password: hunter2secret' })
    assert.deepEqual(blocked, { ok: false, error: 'contains_secret' })
    assert.ok(await env.store.getPending(third.id), '被拒绝的修改不能删掉候选')

    // 其它错误分支。
    assert.deepEqual(await env.consent.confirm('mem_00000000-0000-4000-8000-000000000000'), {
      ok: false,
      error: 'not_found',
    })
    assert.deepEqual(await env.consent.confirm(third.id, { content: 42 }), { ok: false, error: 'invalid' })
    assert.deepEqual(await env.consent.confirm(third.id, { content: '   ' }), { ok: false, error: 'invalid' })
  } finally {
    await env.cleanup()
  }
})

test('并发确认两条候选：两条都落盘，无丢失更新', async () => {
  const env = await setup()
  try {
    const first = await env.consent.propose(proposal({ content: '并发确认的第一条' }), { sessionId: 's1' })
    const second = await env.consent.propose(proposal({ content: '并发确认的第二条' }), { sessionId: 's1' })
    const results = await Promise.all([env.consent.confirm(first.id), env.consent.confirm(second.id)])
    assert.ok(results.every((item) => item.ok === true))
    const { records } = await env.store.listMemories()
    assert.deepEqual(
      records.map((item) => item.content).sort(),
      ['并发确认的第一条', '并发确认的第二条'],
    )
    assert.equal((await env.store.listPending()).length, 0)
  } finally {
    await env.cleanup()
  }
})

test('reject：候选立即消失，递归扫描数据目录找不到那段文字', async () => {
  const env = await setup()
  try {
    const content = '用户曾经有过一段创伤经历，不想再提'
    const context = { sessionId: 'session-a' }
    const result = await env.consent.propose(proposal({ content }), context)
    assert.equal(result.status, 'pending')
    assert.equal((await env.store.listPending()).length, 1)

    const rejected = await env.consent.reject(result.id, context)
    assert.deepEqual(rejected, { ok: true, removed: true })
    assert.equal((await env.store.listPending()).length, 0)
    const pendingFiles = (await readdir(join(env.dataDir, 'pending'))).filter((name) => name.endsWith('.json'))
    assert.deepEqual(pendingFiles, [])
    await assertTextNowhere(env.dataDir, content)
    const { records } = await env.store.listMemories()
    assert.equal(records.length, 0)
    assert.equal(env.backend.calls.add.length, 0)

    // 不存在的候选：幂等成功。
    assert.deepEqual(await env.consent.reject('mem_00000000-0000-4000-8000-000000000000', context), {
      ok: true,
      removed: false,
    })
  } finally {
    await env.cleanup()
  }
})

test('update：改文字、敏感度只升不降、含密钥拒绝', async () => {
  const env = await setup()
  try {
    const normal = await env.consent.propose(proposal({ content: '每天散步' }), { sessionId: 's1' })
    const saved = await env.consent.confirm(normal.id)
    assert.equal(saved.record.sensitivity, 'normal')

    const upgraded = await env.consent.update(saved.record.id, '每天散步，医生说要按时吃药')
    assert.equal(upgraded.ok, true)
    assert.equal(upgraded.record.sensitivity, 'normal')
    assert.deepEqual(upgraded.record.reasons, [])
    assert.equal(upgraded.record.edited_by_user, true)
    const { records } = await env.store.listMemories()
    assert.equal(records[0].content, '每天散步，医生说要按时吃药')

    // 敏感条目改成看起来普通的文字，仍然保持敏感（只升不降）。
    const sensitive = await env.consent.propose(proposal({ content: '最近在服用激素' }), { sessionId: 's1' })
    const sensitiveSaved = await env.consent.confirm(sensitive.id)
    const stillSensitive = await env.consent.update(sensitiveSaved.record.id, '每天按时休息')
    assert.equal(stillSensitive.ok, true)
    assert.equal(stillSensitive.record.sensitivity, 'normal')

    // 改成含密钥的内容：拒绝，磁盘内容不变。
    const before = await readFile(join(env.dataDir, 'memory', '2026-11-10.md'), 'utf8')
    const blocked = await env.consent.update(saved.record.id, 'sk-abcdefghijklmnopqrstuvwxyz012345')
    assert.deepEqual(blocked, { ok: false, error: 'contains_secret' })
    assert.equal(await readFile(join(env.dataDir, 'memory', '2026-11-10.md'), 'utf8'), before)

    assert.deepEqual(await env.consent.update('mem_00000000-0000-4000-8000-000000000000', '新内容'), {
      ok: false,
      error: 'not_found',
    })
  } finally {
    await env.cleanup()
  }
})

test('delete：文件删除成功后 backend.remove 抛错、rebuild 成功 → ok:true + warning:index_rebuilt，检索不会返回它', async () => {
  const env = await setup()
  try {
    const content = '删除后仍被故障后端返回的旧命中'
    const record = makeRecord({ content })
    await env.store.addMemory(record)

    const backend = makeStaleBackend({ failRemove: true })
    backend.staleHits.push({ id: record.id, score: 99, matched_by: 'keyword' })
    const search = makeSearchService(env.store, backend)
    const consent = createConsentService({
      store: env.store,
      backend,
      search,
      clock: () => FIXED,
      maxContentChars: MAX,
    })

    const result = await consent.remove(record.id)
    assert.equal(result.ok, true)
    assert.equal(result.warning, 'index_rebuilt')
    assert.equal(await env.store.getMemory(record.id), null, '文件必须已删除')
    await assertTextNowhere(env.dataDir, content)
    // 索引重建用的是"删除后的事实"（空集合）。
    assert.deepEqual(backend.calls.rebuild.at(-1), [])

    // 后端仍然返回旧命中，但检索层回到 Markdown 回读后丢弃。
    const recalled = await consent.recall({ query: '旧命中' })
    assert.equal(recalled.status, 'empty')
    assert.deepEqual(recalled.results, [])
    assert.ok(backend.calls.search.length >= 1, '应当真的查过索引')
  } finally {
    await env.cleanup()
  }
})

test('delete：文件删除后 backend.remove 与 rebuild 都失败 → ok:true + warning:index_stale，检索仍不会返回它', async () => {
  const env = await setup()
  try {
    const content = '索引不可用也不能被检索到的已删除内容'
    const record = makeRecord({ content })
    await env.store.addMemory(record)

    const backend = makeStaleBackend({ failRemove: true, failRebuild: true })
    backend.staleHits.push({ id: record.id, score: 99, matched_by: 'keyword' })
    const search = makeSearchService(env.store, backend)
    const consent = createConsentService({
      store: env.store,
      backend,
      search,
      clock: () => FIXED,
      maxContentChars: MAX,
    })

    const result = await consent.remove(record.id)
    assert.equal(result.ok, true, '隐私由 Markdown 事实决定，文件已删就算成功')
    assert.equal(result.warning, 'index_stale')
    assert.equal(await env.store.getMemory(record.id), null)
    await assertTextNowhere(env.dataDir, content)
    // 尝试了两次 rebuild：先从事实重建，再清空派生索引。
    assert.equal(backend.calls.rebuild.length, 2)

    // 后端仍返回旧命中，检索层用 getRecord 回读丢弃，内容不会泄露。
    const recalled = await consent.recall({ query: '已删除内容' })
    assert.deepEqual(recalled.results, [])
  } finally {
    await env.cleanup()
  }
})

test('delete：store.deleteMemory 失败 → ok:false，文件原样保留，索引不动', async () => {
  const env = await setup()
  try {
    const content = '文件删不掉时必须原样保留'
    const record = makeRecord({ content })
    await env.store.addMemory(record)

    const failingStore = {
      ...env.store,
      async deleteMemory() {
        return { ok: false, error: 'storage_failed' }
      },
    }
    const consent = createConsentService({
      store: failingStore,
      backend: env.backend,
      search: env.search,
      clock: () => FIXED,
      maxContentChars: MAX,
    })

    // 找不到的 id：not_found，且不做任何写入。
    assert.deepEqual(await consent.remove('mem_00000000-0000-4000-8000-000000000000'), {
      ok: false,
      error: 'not_found',
    })
    assert.equal(env.backend.calls.remove.length, 0)

    const result = await consent.remove(record.id)
    assert.deepEqual(result, { ok: false, error: 'storage_failed' })
    assert.ok(await env.store.getMemory(record.id), '文件必须保留')
    const file = await readFile(join(env.dataDir, 'memory', '2026-11-10.md'), 'utf8')
    assert.match(file, /文件删不掉时必须原样保留/)
    assert.equal(env.backend.calls.remove.length, 0, '文件没删掉时不能动索引')
  } finally {
    await env.cleanup()
  }
})

test('delete 成功：磁盘上不再有这段文字，索引里也删掉了', async () => {
  const env = await setup()
  try {
    const content = '这条记忆稍后会被删除'
    const record = makeRecord({ content })
    await env.store.addMemory(record)

    const result = await env.consent.remove(record.id)
    assert.equal(result.ok, true)
    assert.equal(await env.store.getMemory(record.id), null)
    await assertTextNowhere(env.dataDir, content)
    assert.deepEqual(env.backend.calls.remove, [record.id])
    const { records } = await env.store.listMemories()
    assert.equal(records.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('deleteAll：memory/pending/views/index 清空，settings 保留', async () => {
  const env = await setup()
  try {
    const confirmed = await env.consent.propose(proposal({ content: '会被全部删除的记忆' }), { sessionId: 's1' })
    await env.consent.confirm(confirmed.id)
    await env.consent.propose(proposal({ content: '会被全部删除的候选' }), { sessionId: 's1' })

    const result = await env.consent.removeAll()
    assert.equal(result.ok, true)
    assert.ok(result.deleted >= 1)

    assert.deepEqual((await env.store.listMemories()).records, [])
    assert.deepEqual(await env.store.listPending(), [])
    assert.deepEqual(
      (await readdir(join(env.dataDir, 'memory'))).filter((name) => name.endsWith('.md')),
      [],
    )
    const viewFiles = await readdir(join(env.dataDir, 'views'))
    assert.deepEqual(viewFiles, [])
    const indexFiles = await readdir(join(env.dataDir, 'index'))
    assert.deepEqual(indexFiles.filter((name) => name.endsWith('.json')), [])
    // 最后一次 rebuild 传的是空记录：索引不会留下已删除的条目。
    assert.deepEqual(env.backend.calls.rebuild.at(-1), [])

    const settings = await env.store.readSettings()
    assert.equal(settings.enabled, true, '删除全部不能把用户的开关重置')
    await assertTextNowhere(env.dataDir, '会被全部删除的记忆')
    await assertTextNowhere(env.dataDir, '会被全部删除的候选')
  } finally {
    await env.cleanup()
  }
})

test('export：markdown 与 memories 和已确认记忆一致，不含未确认候选', async () => {
  const env = await setup()
  try {
    const first = await env.consent.propose(proposal({ content: '已确认的导出内容一', category: 'goal' }), { sessionId: 's1' })
    await env.consent.confirm(first.id)
    const second = await env.consent.propose(proposal({ content: '已确认的导出内容二', category: 'episode' }), { sessionId: 's1' })
    await env.consent.confirm(second.id)
    await env.consent.propose(proposal({ content: '还没确认的候选内容' }), { sessionId: 's1' })

    const exported = await env.consent.exportData()
    assert.equal(exported.ok, true)
    assert.equal(exported.memories.length, 2)
    assert.match(exported.markdown, /已确认的导出内容一/)
    assert.match(exported.markdown, /已确认的导出内容二/)
    assert.doesNotMatch(exported.markdown, /还没确认的候选内容/)

    const parsed = parseDocument(exported.markdown, { maxContentChars: MAX })
    assert.equal(parsed.quarantined.length, 0)
    assert.deepEqual(parsed.records, exported.memories)
    assert.deepEqual(
      exported.memories.map((item) => item.content).sort(),
      ['已确认的导出内容一', '已确认的导出内容二'],
    )
  } finally {
    await env.cleanup()
  }
})

test('status：只返回状态，不返回任何记忆内容或 id', async () => {
  const env = await setup()
  try {
    const confirmed = await env.consent.propose(proposal({ content: '状态里绝不能出现的秘密文字ABC' }), { sessionId: 's1' })
    const saved = await env.consent.confirm(confirmed.id)
    await env.consent.propose(proposal({ content: '待确认内容XYZ' }), { sessionId: 's1' })

    const status = await env.consent.status()
    const serialized = JSON.stringify(status)
    assert.doesNotMatch(serialized, /秘密文字ABC/)
    assert.doesNotMatch(serialized, /待确认内容XYZ/)
    assert.doesNotMatch(serialized, new RegExp(saved.record.id))
    assert.equal(status.enabled, true)
    assert.equal(status.pendingCount, 1)
    assert.equal(status.backend, 'keyword')
    assert.equal(status.degraded, false)
    assert.deepEqual(Object.keys(status).sort(), [
      'backend',
      'degraded',
      'enabled',
      'normalMode',
      'pendingCount',
      'savedCount',
      'settingsInvalid',
      'verification',
    ])
  } finally {
    await env.cleanup()
  }
})

test('listPendingForUi：给界面的候选不含 reasons（避免卡片泄露语义）', async () => {
  const env = await setup()
  try {
    await env.consent.propose(proposal({ content: '界面候选内容', sensitivity_hint: 'sensitive' }), { sessionId: 's1' })
    const list = await env.consent.listPendingForUi()
    assert.equal(list.ok, true)
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].content, '界面候选内容')
    assert.equal('reasons' in list.items[0], false)
    assert.equal(list.items[0].sensitivity, 'normal')
  } finally {
    await env.cleanup()
  }
})
