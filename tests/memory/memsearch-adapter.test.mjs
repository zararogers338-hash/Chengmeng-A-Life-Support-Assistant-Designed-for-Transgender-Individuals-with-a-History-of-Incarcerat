/**
 * memsearch 适配层测试（全部使用注入的假 exec；本机没装 memsearch，也不依赖真实命令行）。
 * 重点：参数数组正确、集合名稳定、JSON 解析与 id 映射、错误码稳定且不泄露查询原文、脏标记触发 reindex。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildIndexArgs,
  buildSearchArgs,
  collectionNameFor,
  createMemsearchBackend,
  MEMSEARCH_BACKEND_NAME,
} from '../../plugins/memory-consent/src/backends/memsearch.js'

const MEMORY_DIR = join(tmpdir(), 'chengmeng-memsearch-memory')

/** 造一条虚构记忆记录。 */
function makeRecord(overrides = {}) {
  return {
    id: `mem_${randomUUID()}`,
    content: '下周二有一场面试',
    category: 'episode',
    sensitivity: 'normal',
    created_at: '2026-11-10T03:12:00.000Z',
    ...overrides,
  }
}

/**
 * 假 exec：按预设顺序消费响应，并记录每次调用的 command / args / options。
 * 响应是一个函数，收到 call 后返回 { stdout, code } 或抛错。
 */
function createFakeExec(handlers = []) {
  const calls = []
  const exec = async (command, args, options) => {
    calls.push({ command, args: [...args], options })
    if (handlers.length === 0) {
      throw Object.assign(new Error('假 exec 没有预设结果'), { code: 'MEMSEARCH_FAILED' })
    }
    const handler = handlers.shift()
    return handler({ command, args: [...args], options })
  }
  return { exec, calls }
}

const indexOk = () => ({ stdout: '', code: 0 })
const searchJson = (rows) => () => ({ stdout: JSON.stringify(rows), code: 0 })

/** 造 memsearch --json-output 的单条结果（heading 里带 mem id）。 */
function makeRow(record, score = 0.9) {
  return {
    content: record.content,
    source: 'memory/2026-11-10.md',
    heading: `## ${record.id}`,
    score,
    chunk_hash: `hash-${record.id}`,
  }
}

test('collectionNameFor：同一路径稳定、不同路径不同、格式固定', () => {
  const one = join(tmpdir(), 'chengmeng-memory-one')
  const two = join(tmpdir(), 'chengmeng-memory-two')
  const nameOne = collectionNameFor(one)
  assert.match(nameOne, /^chengmeng_[0-9a-f]{16}$/)
  assert.equal(nameOne, collectionNameFor(one))
  assert.equal(nameOne, collectionNameFor(one + '/'))
  assert.notEqual(nameOne, collectionNameFor(two))
  // 相对路径 resolve 后与绝对路径一致。
  assert.equal(collectionNameFor('.'), collectionNameFor(process.cwd()))
})

test('buildIndexArgs / buildSearchArgs：参数是数组、顺序符合官方先例', () => {
  assert.deepEqual(
    buildIndexArgs({
      memoryDir: 'C:\\data\\memory',
      provider: 'onnx',
      milvusUri: 'http://127.0.0.1:19530',
      collection: 'chengmeng_abc123',
    }),
    [
      'index',
      'C:\\data\\memory',
      '--provider',
      'onnx',
      '--milvus-uri',
      'http://127.0.0.1:19530',
      '--default-collection',
      'chengmeng_abc123',
    ],
  )
  // 没配 provider / milvusUri 时不写这两个开关。
  assert.deepEqual(buildIndexArgs({ memoryDir: '/tmp/memory', collection: 'chengmeng_x' }), [
    'index',
    '/tmp/memory',
    '--default-collection',
    'chengmeng_x',
  ])

  assert.deepEqual(
    buildSearchArgs({ query: '面试', topK: 5, provider: 'onnx', milvusUri: '', collection: 'chengmeng_x' }),
    ['search', '面试', '--top-k', '5', '--json-output', '--provider', 'onnx', '--default-collection', 'chengmeng_x'],
  )
  assert.deepEqual(
    buildSearchArgs({ query: '咖啡', topK: 3, milvusUri: 'http://127.0.0.1:19530', collection: 'c' }),
    ['search', '咖啡', '--top-k', '3', '--json-output', '--milvus-uri', 'http://127.0.0.1:19530', '--default-collection', 'c'],
  )
  assert.throws(() => buildSearchArgs({ query: 'x', topK: 0, collection: 'c' }), RangeError)
  assert.throws(() => buildIndexArgs({ memoryDir: '', collection: 'c' }), TypeError)
})

test('command 为空时整个后端不存在（返回 null）；非空但缺 memoryDir 则报配置错误', () => {
  assert.equal(createMemsearchBackend({ command: '', memoryDir: '/tmp/memory' }), null)
  assert.equal(createMemsearchBackend({ command: '   ', memoryDir: '/tmp/memory' }), null)
  assert.equal(createMemsearchBackend({}), null)
  assert.throws(() => createMemsearchBackend({ command: 'C:\\fake\\memsearch.exe' }), TypeError)
})

test('假 exec 解析 --json-output 并按 heading 映射 id；抽不到 id 的命中被跳过', async () => {
  const record = makeRecord()
  const rows = [makeRow(record, 0.87), { content: '没有 id 的块', heading: '# 无关标题', score: 0.5 }]
  const fake = createFakeExec([indexOk, searchJson(rows)])
  const backend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'chengmeng_test',
    exec: fake.exec,
  })
  assert.equal(backend.name, MEMSEARCH_BACKEND_NAME)

  const hits = await backend.search('面试', { limit: 5 })
  // matched_by 用语义检索的固定取值 'semantic'（后端名字仍是 memsearch）。
  assert.deepEqual(hits, [{ id: record.id, score: 0.87, matched_by: 'semantic' }])

  // 第一次是 index（初始为脏），第二次才是 search。
  assert.equal(fake.calls.length, 2)
  assert.deepEqual(fake.calls[0].args, [
    'index',
    MEMORY_DIR,
    '--provider',
    'onnx',
    '--default-collection',
    'chengmeng_test',
  ])
  assert.equal(fake.calls[0].options.env.MEMSEARCH_NO_WATCH, '1')
  assert.deepEqual(fake.calls[1].args, [
    'search',
    '面试',
    '--top-k',
    '5',
    '--json-output',
    '--provider',
    'onnx',
    '--default-collection',
    'chengmeng_test',
  ])
})

test('parse 宽容：{results:[…]} 与逐行 JSON（NDJSON）都能解析', async () => {
  const first = makeRecord()
  const second = makeRecord()
  const wrapperFake = createFakeExec([indexOk, () => ({ stdout: JSON.stringify({ results: [makeRow(first, 0.6)] }), code: 0 })])
  const wrapperBackend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: wrapperFake.exec,
  })
  assert.deepEqual((await wrapperBackend.search('面试')).map((hit) => hit.id), [first.id])

  const ndjson = [JSON.stringify(makeRow(first, 0.6)), JSON.stringify(makeRow(second, 0.7))].join('\n')
  const ndjsonFake = createFakeExec([indexOk, () => ({ stdout: ndjson, code: 0 })])
  const ndjsonBackend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: ndjsonFake.exec,
  })
  // 按分数降序返回。
  assert.deepEqual((await ndjsonBackend.search('面试')).map((hit) => hit.id), [second.id, first.id])
})

test('超时：抛稳定 MEMSEARCH_TIMEOUT，错误信息里没有查询原文', async () => {
  const record = makeRecord()
  const fake = createFakeExec([indexOk, () => new Promise(() => {})])
  const backend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    timeoutMs: 25,
    exec: fake.exec,
  })
  await backend.rebuild([record])
  await assert.rejects(backend.search('面试的秘密'), (error) => {
    assert.equal(error.code, 'MEMSEARCH_TIMEOUT')
    assert.match(error.message, /^MEMSEARCH_TIMEOUT/)
    assert.ok(!error.message.includes('面试的秘密'), '错误信息不能包含查询原文')
    return true
  })
})

test('非零退出 / 执行失败：抛稳定 MEMSEARCH_FAILED，错误信息里没有查询原文', async () => {
  // 场景一：exec 正常返回但退出码非 0。
  const exitFake = createFakeExec([indexOk, () => ({ stdout: '', code: 3 })])
  const exitBackend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: exitFake.exec,
  })
  await exitBackend.rebuild([])
  await assert.rejects(exitBackend.search('面试的秘密'), (error) => {
    assert.equal(error.code, 'MEMSEARCH_FAILED')
    assert.match(error.message, /exit_code=3/)
    assert.ok(!error.message.includes('面试的秘密'))
    return true
  })

  // 场景二：exec 直接抛错且原始 message 里带查询原文——必须被丢弃，只保留 code。
  const throwFake = createFakeExec([
    indexOk,
    () => {
      throw new Error('执行失败：面试的秘密 这段不能出现在错误里')
    },
  ])
  const throwBackend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: throwFake.exec,
  })
  await throwBackend.rebuild([])
  await assert.rejects(throwBackend.search('面试的秘密'), (error) => {
    assert.equal(error.code, 'MEMSEARCH_FAILED')
    assert.ok(!error.message.includes('面试的秘密'))
    assert.ok(!error.message.includes('执行失败'))
    return true
  })
})

test('add / remove 只标脏，search 前会先 reindex；不脏时不再 index', async () => {
  const record = makeRecord()
  const rows = [makeRow(record, 0.8)]
  const fake = createFakeExec([
    indexOk,
    indexOk,
    searchJson(rows),
    searchJson(rows),
    indexOk,
    searchJson(rows),
  ])
  const backend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: fake.exec,
  })

  await backend.rebuild([record])
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].args[0], 'index')

  await backend.add(record)
  assert.equal(fake.calls.length, 1, 'add 本身不 spawn 子进程')

  assert.deepEqual((await backend.search('面试')).map((hit) => hit.id), [record.id])
  assert.equal(fake.calls.length, 3)
  assert.equal(fake.calls[1].args[0], 'index')
  assert.equal(fake.calls[2].args[0], 'search')

  // 不脏：只 search。
  await backend.search('面试')
  assert.equal(fake.calls.length, 4)
  assert.equal(fake.calls[3].args[0], 'search')

  await backend.remove(record.id)
  await backend.search('面试')
  assert.equal(fake.calls.length, 6)
  assert.equal(fake.calls[4].args[0], 'index')
  assert.equal(fake.calls[5].args[0], 'search')
})

test('rebuild / reindex 都执行 index 命令并带上 MEMSEARCH_NO_WATCH=1', async () => {
  const fake = createFakeExec([indexOk, indexOk])
  const backend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: fake.exec,
  })
  const rebuilt = await backend.rebuild([])
  assert.equal(rebuilt.ok, true)
  assert.equal(rebuilt.docs, 0)
  assert.equal(fake.calls[0].args[0], 'index')
  assert.equal(fake.calls[0].options.env.MEMSEARCH_NO_WATCH, '1')

  await backend.reindex()
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.calls[1].args[0], 'index')
  assert.equal(fake.calls[1].options.env.MEMSEARCH_NO_WATCH, '1')
})

test('health 只用 fs.access 判断 command，不 spawn 子进程；未配置集合时由路径派生', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chengmeng-memsearch-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const command = join(dir, 'memsearch-fake.exe')
  await writeFile(command, '', 'utf8')
  const fake = createFakeExec([]) // 任何调用都会失败，用来证明 health 没 spawn
  const backend = createMemsearchBackend({
    command,
    memoryDir: join(dir, 'memory'),
    exec: fake.exec,
  })
  const health = await backend.health()
  assert.equal(health.ok, true)
  assert.equal(health.backend, MEMSEARCH_BACKEND_NAME)
  assert.equal(health.command_available, true)
  assert.equal(health.collection, collectionNameFor(join(dir, 'memory')))
  assert.equal(health.dirty, true)
  assert.equal(fake.calls.length, 0)

  const missing = createMemsearchBackend({
    command: join(dir, '并不存在', 'memsearch.exe'),
    memoryDir: join(dir, 'memory'),
    exec: fake.exec,
  })
  const missingHealth = await missing.health()
  assert.equal(missingHealth.ok, false)
  assert.equal(missingHealth.command_available, false)
  assert.equal(missingHealth.reason, 'command_unavailable')
  assert.equal(fake.calls.length, 0)
})

test('signal 已中止时 search 立刻抛 AbortError，不 spawn 子进程', async () => {
  const fake = createFakeExec([])
  const backend = createMemsearchBackend({
    command: 'C:\\fake\\memsearch.exe',
    memoryDir: MEMORY_DIR,
    collection: 'c',
    exec: fake.exec,
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(backend.search('面试', { signal: controller.signal }), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.equal(fake.calls.length, 0)
  assert.equal((await backend.search('')).length, 0)
})
