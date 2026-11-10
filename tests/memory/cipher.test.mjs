import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CIPHER_IDENTITY, createIdentityCipher, resolveStorageCipher } from '../../plugins/memory-consent/src/cipher.js'
import { createStore } from '../../plugins/memory-consent/src/store.js'
import { buildRecord } from '../../plugins/memory-consent/src/model.js'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cm-cipher-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 测试用的"加密"：每个字节 XOR 0x5A。不是真加密，只用来证明存储层真的经过 cipher。 */
function createXorCipher() {
  const xor = (bytes) => Uint8Array.from(bytes, (byte) => byte ^ 0x5a)
  return {
    id: 'xor-test',
    async encrypt(bytes) {
      return xor(Uint8Array.from(bytes))
    },
    async decrypt(bytes) {
      return xor(Uint8Array.from(bytes))
    },
  }
}

test('恒等 cipher：encrypt/decrypt 原样往返，标识为 identity', async () => {
  const cipher = createIdentityCipher()
  assert.equal(cipher.id, CIPHER_IDENTITY)
  const bytes = Buffer.from('用户喜欢晚上散步 😀', 'utf8')
  assert.deepEqual(Buffer.from(await cipher.encrypt(bytes)), bytes)
  assert.deepEqual(Buffer.from(await cipher.decrypt(bytes)), bytes)
})

test('resolveStorageCipher：缺省是恒等实现；传入非法 cipher 直接报错', () => {
  assert.equal(resolveStorageCipher().id, CIPHER_IDENTITY)
  assert.equal(resolveStorageCipher({ cipher: null }).id, CIPHER_IDENTITY)
  assert.throws(() => resolveStorageCipher({ cipher: { id: 'bad' } }), /StorageCipher 必须提供 encrypt \/ decrypt/)
})

test('store 的文本读写都经过注入的 cipher：磁盘不是明文，读回来仍是原文', async () => {
  await withTempDir(async (dir) => {
    const dataDir = join(dir, 'chengmeng', 'memory')
    const store = createStore({ dataDir, cipher: createXorCipher(), timeZone: 'UTC' })

    // 设置写盘：磁盘字节应该是 XOR 过的，不应包含明文。
    await store.writeSettings({ enabled: true, normalMode: 'auto' })
    const rawSettings = await readFile(join(dataDir, 'settings.json'))
    assert.equal(rawSettings.includes(Buffer.from('normalMode', 'utf8')), false)
    assert.deepEqual(await store.readSettings(), { version: 1, enabled: true, normalMode: 'auto' })

    // 记忆写盘：Markdown 文件同样加密，读取后正确解析。
    const record = buildRecord({
      content: '用户喜欢在晚上散步',
      category: 'preference',
      sensitivity: 'normal',
      reasons: [],
      source: 'session:cipher-test#turn:1',
      quote_verified: 'unknown',
      confirmed_by_user: true,
      clock: () => new Date('2026-11-10T03:12:00.000Z'),
    })
    await store.addMemory(record)
    // 文件名按"确认当天"的本地日期（UTC）生成，所以这里直接取目录里唯一的记忆文件。
    const memoryFiles = await readdir(join(dataDir, 'memory'))
    assert.equal(memoryFiles.length, 1)
    const dayFile = await readFile(join(dataDir, 'memory', memoryFiles[0]))
    assert.equal(dayFile.includes(Buffer.from('晚上散步', 'utf8')), false)
    const { records } = await store.listMemories()
    assert.equal(records.length, 1)
    assert.equal(records[0].content, '用户喜欢在晚上散步')

    // 候选队列也走 cipher。
    await store.addPending({ ...record, id: 'mem_11111111-1111-4111-8111-111111111111', confirmed_by_user: false, status: 'pending' })
    const rawPending = await readFile(join(dataDir, 'pending', 'mem_11111111-1111-4111-8111-111111111111.json'))
    assert.equal(rawPending.includes(Buffer.from('晚上散步', 'utf8')), false)
    const pending = await store.listPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].content, '用户喜欢在晚上散步')
  })
})

test('不注入 cipher 时默认恒等实现：磁盘是明文（依赖系统磁盘加密），读回一致', async () => {
  await withTempDir(async (dir) => {
    const dataDir = join(dir, 'chengmeng', 'memory')
    const store = createStore({ dataDir, timeZone: 'UTC' })
    await store.writeSettings({ enabled: true })
    const raw = await readFile(join(dataDir, 'settings.json'), 'utf8')
    assert.equal(raw.includes('normalMode'), true)
    assert.deepEqual(await store.readSettings(), { version: 1, enabled: true, normalMode: 'confirm' })
  })
})
