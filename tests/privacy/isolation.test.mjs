/**
 * 隐私回归 #5：隔离。
 * - 两个不同 dataDir 的 store 互不可见；
 * - 不同 DSH_HOME 解析到不同数据目录，会话工作目录不影响数据位置；
 * - memsearch 集合名由数据目录路径哈希派生，不同目录不同集合名；
 * - 关键词索引也按数据目录隔离。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { resolveDataDir, validateConfig } from '../../plugins/memory-consent/src/config.js'
import { createKeywordBackend } from '../../plugins/memory-consent/src/backends/keyword.js'
import { collectionNameFor } from '../../plugins/memory-consent/src/backends/memsearch.js'
import { buildRecord, validateMemoryRecord } from '../../plugins/memory-consent/src/model.js'

const FIXED = new Date('2026-11-10T03:12:00.000Z')

function makeRecord(content) {
  const built = buildRecord({
    content,
    category: 'preference',
    sensitivity: 'normal',
    reasons: [],
    source: 'session:test-session#turn:1',
    quote_verified: 'unknown',
    confirmed_by_user: true,
    clock: () => FIXED,
  })
  const checked = validateMemoryRecord(built, { maxContentChars: 280 })
  assert.ok(checked.ok, checked.ok ? '' : checked.error)
  return checked.value
}

test('两个不同 dataDir 的 store 互不可见', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-isolation-'))
  try {
    const dirA = join(root, 'data-a')
    const dirB = join(root, 'data-b')
    const storeA = createStore({ dataDir: dirA, clock: () => FIXED })
    const storeB = createStore({ dataDir: dirB, clock: () => FIXED })

    const recordA = makeRecord('A 数据目录里的虚构记忆')
    await storeA.addMemory(recordA)

    const listA = await storeA.listMemories()
    assert.equal(listA.records.length, 1)
    const listB = await storeB.listMemories()
    assert.deepEqual(listB.records, [], 'B 不能看到 A 的记忆')
    assert.equal(await storeB.getMemory(recordA.id), null)
    assert.equal(await storeB.getMemory(recordA.id), null)

    const recordB = makeRecord('B 数据目录里的虚构记忆')
    await storeB.addMemory(recordB)
    const listA2 = await storeA.listMemories()
    assert.deepEqual(listA2.records.map((item) => item.content), ['A 数据目录里的虚构记忆'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('不同 DSH_HOME 解析到不同数据目录；同一 DSH_HOME 结果稳定', async () => {
  const homeA = join(tmpdir(), 'fixture-home-a')
  const homeB = join(tmpdir(), 'fixture-home-b')
  const config = validateConfig({})
  const pathA = resolveDataDir(config, { env: { DSH_HOME: homeA }, home: homeA })
  const pathB = resolveDataDir(config, { env: { DSH_HOME: homeB }, home: homeB })
  assert.notEqual(pathA, pathB)
  assert.equal(pathA, join(homeA, 'chengmeng', 'memory'))
  assert.equal(pathB, join(homeB, 'chengmeng', 'memory'))
  assert.equal(resolveDataDir(config, { env: { DSH_HOME: homeA }, home: homeA }), pathA)
})

test('会话工作目录不影响数据位置', async () => {
  const originalCwd = process.cwd()
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-cwd-'))
  try {
    const fakeHome = join(root, 'home')
    const config = validateConfig({})
    const before = resolveDataDir(config, { env: { DSH_HOME: fakeHome }, home: fakeHome })

    process.chdir(root)
    try {
      const after = resolveDataDir(config, { env: { DSH_HOME: fakeHome }, home: fakeHome })
      assert.equal(after, before)
      assert.equal(after, join(fakeHome, 'chengmeng', 'memory'))
    } finally {
      process.chdir(originalCwd)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('memsearch 集合名由数据目录路径哈希派生：不同目录不同集合，同一目录稳定', () => {
  const root = join(tmpdir(), 'chengmeng-collection-fixture')
  const nameA = collectionNameFor(join(root, 'a'))
  const nameB = collectionNameFor(join(root, 'b'))
  assert.notEqual(nameA, nameB)
  assert.equal(collectionNameFor(join(root, 'a')), nameA)
  assert.match(nameA, /^chengmeng_[0-9a-f]{16}$/)
  // 同一路径的不同写法（尾部分隔符）也应得到同一个集合名。
  assert.equal(collectionNameFor(`${join(root, 'a')}\\`), nameA)
})

test('memsearch 集合名在 Windows 上大小写不敏感（同一目录不能产生两个集合）', { skip: process.platform !== 'win32' }, () => {
  const upper = 'C:\\Fixture\\Data'
  const lower = 'c:\\fixture\\data'
  assert.equal(collectionNameFor(upper), collectionNameFor(lower))
})

test('关键词索引也按数据目录隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-index-'))
  try {
    const dirA = join(root, 'data-a')
    const dirB = join(root, 'data-b')
    const backendA = createKeywordBackend({ dataDir: dirA, clock: () => FIXED })
    const backendB = createKeywordBackend({ dataDir: dirB, clock: () => FIXED })

    const record = makeRecord('独一无二的隔离测试词汇：紫藤花')
    await backendA.rebuild([record])
    const hitsA = await backendA.search('紫藤花')
    assert.equal(hitsA.length, 1)
    assert.equal(hitsA[0].id, record.id)

    const hitsB = await backendB.search('紫藤花')
    assert.deepEqual(hitsB, [], 'B 目录的索引不能命中 A 目录的内容')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
