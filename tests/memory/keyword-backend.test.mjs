/**
 * 关键词后端（BM25 + 中文 bigram）测试。
 * 全部虚构数据；临时目录用 os.tmpdir() + mkdtemp，测完清理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createKeywordBackend,
  tokenize,
  KEYWORD_BACKEND_NAME,
} from '../../plugins/memory-consent/src/backends/keyword.js'

const FIXED_TIME = '2026-11-10T03:12:00.000Z'

/** 造一条虚构记忆记录（字段与 §4.2 一致）。 */
function makeRecord(overrides = {}) {
  return {
    id: `mem_${randomUUID()}`,
    content: '用户喜欢喝咖啡',
    category: 'preference',
    sensitivity: 'normal',
    reasons: [],
    source: 'session:test#turn:1',
    quote_verified: 'unknown',
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    confirmed_by_user: true,
    edited_by_user: false,
    ...overrides,
  }
}

/** 建一个临时数据目录，测试结束自动清理。 */
async function makeDataDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chengmeng-keyword-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('tokenize：CJK 切成单字 + 相邻 bigram，拉丁数字按词切并小写', () => {
  assert.deepEqual(tokenize('面试'), ['面', '试', '面试'])
  assert.deepEqual(tokenize('下周二'), ['下', '周', '二', '下周', '周二'])
  assert.deepEqual(tokenize('Hello, World 2026!'), ['hello', 'world', '2026'])
  assert.deepEqual(tokenize('BM25 检索'), ['bm25', '检', '索', '检索'])
  assert.deepEqual(tokenize('!!!???'), [])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
  // 重复 token 保留（BM25 需要词频）
  assert.equal(tokenize('面试面试').filter((token) => token === '面试').length, 2)
})

test('BM25 打分：词频高、文档较短的命中排在前面，且不返回 0 分', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  const high = makeRecord({ content: '咖啡 咖啡 咖啡' })
  const middle = makeRecord({ content: '咖啡 茶 茶' })
  const low = makeRecord({ content: '咖啡 茶 茶 茶 茶 茶' })
  await backend.rebuild([middle, low, high])

  const hits = await backend.search('咖啡')
  assert.deepEqual(hits.map((hit) => hit.id), [high.id, middle.id, low.id])
  for (let index = 1; index < hits.length; index += 1) {
    assert.ok(hits[index - 1].score > hits[index].score, '分数应严格递减')
  }
  for (const hit of hits) {
    assert.ok(hit.score > 0)
    assert.equal(hit.matched_by, 'keyword')
  }
})

test('中文检索：「面试」能命中「下周二有一场面试」', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  const interview = makeRecord({ content: '下周二有一场面试', category: 'episode' })
  const unrelated = makeRecord({ content: '周末想去公园散步', category: 'preference' })
  await backend.rebuild([interview, unrelated])

  const hits = await backend.search('面试')
  assert.deepEqual(hits.map((hit) => hit.id), [interview.id])
  assert.ok(hits[0].score > 0)
  // 切分确实产生了 bigram：查询「面试」与文档里的「面试」共享 token。
  assert.ok(tokenize('下周二有一场面试').includes('面试'))
})

test('类别与时间范围过滤（按记录元数据）', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  const earlyPreference = makeRecord({
    content: '喜欢喝咖啡',
    category: 'preference',
    created_at: '2026-11-01T00:00:00.000Z',
  })
  const goal = makeRecord({
    content: '准备咖啡师考试',
    category: 'goal',
    created_at: '2026-11-05T00:00:00.000Z',
  })
  const latePreference = makeRecord({
    content: '咖啡因过敏要少喝',
    category: 'preference',
    created_at: '2026-11-10T00:00:00.000Z',
  })
  await backend.rebuild([earlyPreference, goal, latePreference])

  const sortIds = (hits) => hits.map((hit) => hit.id).sort()
  assert.deepEqual(sortIds(await backend.search('咖啡')), sortIds([earlyPreference, goal, latePreference]).sort())
  assert.deepEqual(
    sortIds(await backend.search('咖啡', { categories: ['preference'] })),
    sortIds([earlyPreference, latePreference]),
  )
  assert.deepEqual(sortIds(await backend.search('咖啡', { categories: 'goal' })), [goal.id])
  assert.deepEqual(sortIds(await backend.search('咖啡', { since: '2026-11-03T00:00:00.000Z' })), sortIds([goal, latePreference]))
  assert.deepEqual(sortIds(await backend.search('咖啡', { until: '2026-11-02T00:00:00.000Z' })), [earlyPreference.id])
  assert.deepEqual(
    sortIds(
      await backend.search('咖啡', {
        since: '2026-11-04T00:00:00.000Z',
        until: '2026-11-06T00:00:00.000Z',
      }),
    ),
    [goal.id],
  )
  // 空数组等价于不过滤，不会静默返回空结果。
  assert.equal((await backend.search('咖啡', { categories: [] })).length, 3)
})

test('limit 只截断结果数量，不影响排序', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  const records = [
    makeRecord({ content: '咖啡 咖啡 咖啡' }),
    makeRecord({ content: '咖啡 茶 茶' }),
    makeRecord({ content: '咖啡 茶 茶 茶 茶 茶' }),
  ]
  await backend.rebuild(records)
  const all = await backend.search('咖啡')
  const limited = await backend.search('咖啡', { limit: 1 })
  assert.equal(all.length, 3)
  assert.deepEqual(limited.map((hit) => hit.id), [all[0].id])
  assert.deepEqual(await backend.search('咖啡', { limit: 0 }), [])
  assert.deepEqual(await backend.search('咖啡', { limit: 2 }), all.slice(0, 2))
})

test('索引 JSON 损坏或缺失时不崩溃：isIndexed()/health().ok 为 false，可 rebuild 修复', async (t) => {
  const dataDir = await makeDataDir(t)
  await mkdir(join(dataDir, 'index'), { recursive: true })
  const indexPath = join(dataDir, 'index', 'keyword.json')
  await writeFile(indexPath, '{ 这不是合法 JSON', 'utf8')

  const backend = createKeywordBackend({ dataDir })
  assert.equal(await backend.isIndexed(), false)
  const unhealthy = await backend.health()
  assert.equal(unhealthy.ok, false)
  assert.equal(unhealthy.backend, KEYWORD_BACKEND_NAME)
  assert.equal(unhealthy.docs, 0)
  assert.equal(unhealthy.reason, 'index_corrupt')
  assert.deepEqual(await backend.search('面试'), [])

  // 损坏状态下 add 只进内存（不拿残缺索引覆盖磁盘），显式 rebuild 后恢复。
  const record = makeRecord({ content: '下周二有一场面试' })
  await backend.add(record)
  assert.deepEqual((await backend.search('面试')).map((hit) => hit.id), [record.id])
  assert.equal(await backend.isIndexed(), false)

  await backend.rebuild([record])
  assert.equal(await backend.isIndexed(), true)
  const healthy = await backend.health()
  assert.equal(healthy.ok, true)
  assert.equal(healthy.docs, 1)
  assert.equal(healthy.reason, undefined)
  assert.deepEqual(JSON.parse(await readFile(indexPath, 'utf8')).docs.map((doc) => doc.id), [record.id])
})

test('索引文件缺失：不崩溃、状态可读，rebuild 可重建', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  assert.equal(await backend.isIndexed(), false)
  const health = await backend.health()
  assert.equal(health.ok, false)
  assert.equal(health.reason, 'index_missing')
  assert.deepEqual(await backend.search('面试'), [])

  const record = makeRecord({ content: '下周二有一场面试' })
  await backend.rebuild([record])
  assert.deepEqual((await backend.search('面试')).map((hit) => hit.id), [record.id])
})

test('add / remove 后检索结果随之变化，并写回磁盘', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  const first = makeRecord({ content: '下周二有一场面试' })
  const second = makeRecord({ content: '面试前要准备作品集' })
  await backend.rebuild([first])
  assert.deepEqual((await backend.search('面试')).map((hit) => hit.id), [first.id])

  await backend.add(second)
  assert.deepEqual(new Set((await backend.search('面试')).map((hit) => hit.id)), new Set([first.id, second.id]))

  await backend.remove(first.id)
  assert.deepEqual((await backend.search('面试')).map((hit) => hit.id), [second.id])

  // 新实例从磁盘加载后，删除仍然生效、新增仍然存在。
  const reloaded = createKeywordBackend({ dataDir })
  assert.equal(await reloaded.isIndexed(), true)
  assert.deepEqual((await reloaded.search('面试')).map((hit) => hit.id), [second.id])
  await reloaded.remove(second.id)
  assert.deepEqual(await reloaded.search('面试'), [])
})

test('rebuild 持久化索引；整个索引目录删掉后仍能由 rebuild 重建', async (t) => {
  const dataDir = await makeDataDir(t)
  const record = makeRecord({ content: '下周二有一场面试', category: 'goal' })
  const backend = createKeywordBackend({ dataDir })
  const built = await backend.rebuild([record])
  assert.equal(built.docs, 1)

  const indexPath = join(dataDir, 'index', 'keyword.json')
  const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
  assert.equal(parsed.version, 2)
  assert.equal(parsed.docs.length, 1)
  assert.equal(parsed.docs[0].id, record.id)
  // 索引不复制正文（只有派生词频）。
  assert.equal(typeof parsed.docs[0].content, 'undefined')

  const reopened = createKeywordBackend({ dataDir })
  assert.equal(await reopened.isIndexed(), true)
  assert.equal((await reopened.health()).docs, 1)
  assert.deepEqual((await reopened.search('面试')).map((hit) => hit.id), [record.id])

  await rm(join(dataDir, 'index'), { recursive: true, force: true })
  const repaired = createKeywordBackend({ dataDir })
  assert.equal(await repaired.isIndexed(), false)
  await repaired.rebuild([record])
  assert.equal(await repaired.isIndexed(), true)
  assert.deepEqual((await repaired.search('面试')).map((hit) => hit.id), [record.id])
})

test('原子写：rename 短暂失败会重试成功；持续失败明确报错且不留半截文件、旧索引被作废', async (t) => {
  const dataDir = await makeDataDir(t)
  const record = makeRecord({ content: '下周二有一场面试' })
  const indexPath = join(dataDir, 'index', 'keyword.json')

  // 前两次 rename 失败（模拟 Windows 上被杀毒/索引服务短暂占用），第三次成功。
  let remainingFailures = 2
  const flakyFs = {
    async rename(from, to) {
      if (remainingFailures > 0) {
        remainingFailures -= 1
        const error = new Error('EBUSY: 文件被占用')
        error.code = 'EBUSY'
        throw error
      }
      return rename(from, to)
    },
  }
  const flakyBackend = createKeywordBackend({ dataDir, fsImpl: flakyFs })
  await flakyBackend.rebuild([record])
  assert.equal(await flakyBackend.isIndexed(), true)
  assert.equal((await flakyBackend.health()).docs, 1)

  // 持续失败：明确抛错，临时文件被清理，旧索引被作废（派生数据可重建），不留半截文件。
  const failingBackend = createKeywordBackend({
    dataDir,
    fsImpl: {
      async rename() {
        const error = new Error('EACCES: 拒绝访问')
        error.code = 'EACCES'
        throw error
      },
    },
  })
  await assert.rejects(failingBackend.rebuild([record]))
  const entries = await readdir(join(dataDir, 'index'))
  assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [])
  assert.equal(entries.includes('keyword.json'), false, '写失败的旧索引不能留到下次启动被信任')
  assert.equal(await failingBackend.isIndexed(), false)
  assert.equal((await failingBackend.health()).reason, 'persist_failed')

  // 下一次启动看到索引缺失 → 明确走重建，恢复完整索引。
  const recovered = createKeywordBackend({ dataDir })
  assert.equal(await recovered.isIndexed(), false)
  await recovered.rebuild([record])
  assert.equal(await recovered.isIndexed(), true)
  assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).docs.length, 1)
  assert.deepEqual((await recovered.search('面试')).map((hit) => hit.id), [record.id])
})

test('空查询、纯标点查询返回空数组；不可取消的 signal 不影响结果', async (t) => {
  const dataDir = await makeDataDir(t)
  const backend = createKeywordBackend({ dataDir })
  const record = makeRecord({ content: '下周二有一场面试' })
  await backend.rebuild([record])
  assert.deepEqual(await backend.search(''), [])
  assert.deepEqual(await backend.search('   '), [])
  assert.deepEqual(await backend.search('？！。'), [])
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await backend.search('面试', { signal: controller.signal }), [])
})
