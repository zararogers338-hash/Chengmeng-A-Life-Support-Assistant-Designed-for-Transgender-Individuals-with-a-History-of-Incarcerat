/**
 * 隐私回归 #2：用户点「不用」之后，磁盘上任何位置都找不到那段文字。
 * 覆盖 pending/、memory/、views/、index/ 以及整个数据目录的递归扫描。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createKeywordBackend } from '../../plugins/memory-consent/src/backends/keyword.js'

const FIXED = new Date('2026-11-10T03:12:00.000Z')

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
          // 读不了的文件跳过。
        }
      }
    }
  }
  await walk(root)
  return texts
}

async function assertTextNowhere(root, needle) {
  const texts = await readAllTexts(root)
  for (const item of texts) assert.ok(!item.text.includes(needle), `磁盘上不应出现这段文字：${item.path}`)
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-reject-'))
  const dataDir = join(root, 'memory-data')
  const store = createStore({ dataDir, clock: () => FIXED, maxContentChars: 280 })
  await store.writeSettings({ enabled: true, normalMode: 'confirm' })
  // 用真实关键词后端，确保索引文件也参与扫描。
  const backend = createKeywordBackend({ dataDir, clock: () => FIXED })
  const added = []
  const search = { searchMemories: async () => ({ results: [], backend_used: 'keyword', degraded: false }) }
  const consent = createConsentService({
    store,
    backend: {
      async add(record) {
        added.push(record)
        return backend.add(record)
      },
      remove: (id) => backend.remove(id),
      search: (query, options) => backend.search(query, options),
      rebuild: (records) => backend.rebuild(records),
      health: () => backend.health(),
    },
    search,
    clock: () => FIXED,
  })
  return { root, dataDir, store, backend, added, consent, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('reject 后 pending 消失，数据目录递归扫描找不到那段文字，索引里没有该条目', async () => {
  const env = await setup()
  try {
    const content = '用户曾经有过一段创伤经历，不想再提'
    const context = { sessionId: 'session-a' }
    const proposed = await env.consent.propose(
      {
        content,
        category: 'explicit',
        sensitivity_hint: 'normal',
        user_quote: '这是虚构的用户原话',
        stated_by_user: true,
      },
      context,
    )
    assert.equal(proposed.status, 'pending')

    // 确认候选确实落在 pending/（否则这个测试就没有意义）。
    const pendingFiles = (await readdir(join(env.dataDir, 'pending'))).filter((name) => name.endsWith('.json'))
    assert.equal(pendingFiles.length, 1)
    const pendingRaw = await readFile(join(env.dataDir, 'pending', pendingFiles[0]), 'utf8')
    assert.match(pendingRaw, new RegExp(content.slice(0, 6)))

    const rejected = await env.consent.reject(proposed.id, context)
    assert.deepEqual(rejected, { ok: true, removed: true })

    // 1) pending/ 里没有。
    assert.deepEqual(
      (await readdir(join(env.dataDir, 'pending'))).filter((name) => name.endsWith('.json')),
      [],
    )
    // 2) memory/ 里没有。
    const { records } = await env.store.listMemories()
    assert.equal(records.length, 0)
    // 3) 磁盘上任何位置都没有。
    await assertTextNowhere(env.dataDir, content)
    // 4) 索引里没有（add 从未被调用；keyword 索引里也不该有这个词）。
    assert.equal(env.added.length, 0)
    const hits = await env.backend.search('创伤经历')
    assert.deepEqual(hits, [])
    // 5) 拒绝缓存只留指纹，不落盘原文。
    assert.equal(env.consent.rejectedCache.size, 1)
    await assertTextNowhere(env.dataDir, content)
  } finally {
    await env.cleanup()
  }
})

test('reject 后同一会话不重复提议；不同会话可以重新提议（缓存不落盘）', async () => {
  const env = await setup()
  try {
    const content = '虚构的一条普通偏好：喜欢下雨天'
    const context = { sessionId: 'session-a' }
    const first = await env.consent.propose(
      {
        content,
        category: 'preference',
        sensitivity_hint: 'normal',
        user_quote: '虚构原话',
        stated_by_user: true,
      },
      context,
    )
    await env.consent.reject(first.id, context)

    const again = await env.consent.propose(
      {
        content,
        category: 'preference',
        sensitivity_hint: 'normal',
        user_quote: '虚构原话',
        stated_by_user: true,
      },
      context,
    )
    assert.equal(again.status, 'duplicate')

    const other = await env.consent.propose(
      {
        content,
        category: 'preference',
        sensitivity_hint: 'normal',
        user_quote: '虚构原话',
        stated_by_user: true,
      },
      { sessionId: 'session-b' },
    )
    assert.equal(other.status, 'pending')
    // 拒绝缓存只在内存里：磁盘上只有一个新候选，且不含任何"已拒绝"标记。
    assert.equal((await env.store.listPending()).length, 1)
    assert.equal(env.consent.rejectedCache.size, 1)
  } finally {
    await env.cleanup()
  }
})
