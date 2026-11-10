/**
 * 隐私回归 #4：「绝不存」——密钥、令牌、密码、身份证号、银行卡号、验证码。
 *
 * 要求：提议阶段直接拒绝；拒绝信息、日志、磁盘上都没有这段内容；候选队列里也没有。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'

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
          // 跳过读不了的文件。
        }
      }
    }
  }
  await walk(root)
  return texts
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-secrets-'))
  const dataDir = join(root, 'memory-data')
  const store = createStore({ dataDir, clock: () => FIXED })
  await store.writeSettings({ enabled: true, normalMode: 'auto' })
  const logs = []
  const backendCalls = []
  const backend = {
    async add(record) {
      backendCalls.push(record)
    },
    async remove() {},
    async search() {
      return []
    },
    async rebuild() {
      return { ok: true }
    },
    async health() {
      return { ok: true }
    },
  }
  const consent = createConsentService({
    store,
    backend,
    search: { searchMemories: async () => ({ results: [], backend_used: 'keyword', degraded: false }) },
    clock: () => FIXED,
    logger: { warn: (message) => logs.push(message), info: (message) => logs.push(message) },
  })
  return { root, dataDir, store, consent, logs, backendCalls, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const SECRET_CASES = [
  ['sk- 开头的 API Key', '我的密钥是 sk-abcdefghijklmnopqrstuvwxyz012345，请记住'],
  ['Bearer 令牌', '请求头是 Bearer abcdefghijklmnop123456'],
  ['password 赋值', 'password: hunter2secret'],
  ['中文密码', '我的密码是 abcdefg'],
  ['18 位身份证号', '身份证号 11010519491231002X 帮我记一下'],
  ['银行卡号', '卡号 4111111111111111 别弄丢'],
  ['验证码', '验证码是 483920，十分钟内有效'],
]

test('七类秘密内容在提议阶段全部被拒绝，不进入待确认队列', async () => {
  const env = await setup()
  try {
    for (const [name, content] of SECRET_CASES) {
      const result = await env.consent.propose(
        {
          content,
          category: 'explicit',
          sensitivity_hint: 'normal',
          user_quote: '这是虚构的用户原话',
          stated_by_user: true,
        },
        { sessionId: 'session-a' },
      )
      assert.equal(result.status, 'rejected_by_policy', `${name} 应当被拒绝`)
      assert.match(result.message, /不能写入记忆/)
    }
    assert.equal((await env.store.listPending()).length, 0, '被拒绝的秘密不能进入待确认队列')
    assert.equal((await env.store.listMemories()).records.length, 0)
    assert.equal(env.backendCalls.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('拒绝信息、日志、磁盘上都没有秘密原文', async () => {
  const env = await setup()
  try {
    for (const [name, content] of SECRET_CASES) {
      const result = await env.consent.propose(
        {
          content,
          category: 'explicit',
          sensitivity_hint: 'normal',
          user_quote: '这是虚构的用户原话',
          stated_by_user: true,
        },
        { sessionId: 'session-a' },
      )
      const serialized = JSON.stringify(result)
      // 返回值里不能出现原文（这里用内容里的特征片段检查）。
      const fragments = content
        .replace(/^[^:：]*[:：]?/, '')
        .split(/[，,。]/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 6)
      for (const fragment of fragments) {
        assert.ok(!serialized.includes(fragment), `${name} 的返回值不能回显原文片段：${fragment}`)
      }
    }

    // 日志里也不能有秘密原文。
    for (const message of env.logs) {
      for (const [name, content] of SECRET_CASES) {
        for (const fragment of content.split(/[，,。]/).map((item) => item.trim()).filter((item) => item.length >= 6)) {
          assert.ok(!message.includes(fragment), `${name} 的内容不能写进日志`)
        }
      }
    }

    // 磁盘上不能有秘密原文。
    const texts = await readAllTexts(env.dataDir)
    for (const [name, content] of SECRET_CASES) {
      for (const fragment of content.split(/[，,。]/).map((item) => item.trim()).filter((item) => item.length >= 6)) {
        for (const item of texts) {
          assert.ok(!item.text.includes(fragment), `${name} 的内容不能落盘：${item.path}`)
        }
      }
    }
  } finally {
    await env.cleanup()
  }
})

test('确认时用户改出来的秘密内容同样被拒绝，候选保留且磁盘不变', async () => {
  const env = await setup()
  try {
    await env.store.writeSettings({ enabled: true, normalMode: 'confirm' })
    // auto 模式会直接保存普通条目；这里用敏感内容让候选停在 pending，再在确认时改成密钥。
    const proposed = await env.consent.propose(
      {
        content: '最近在服用激素',
        category: 'explicit',
        sensitivity_hint: 'normal',
        user_quote: '虚构原话',
        stated_by_user: true,
      },
      { sessionId: 'session-a' },
    )
    assert.equal(proposed.status, 'pending')

    const before = await readAllTexts(env.dataDir)
    const confirmed = await env.consent.confirm(proposed.id, { content: 'sk-abcdefghijklmnopqrstuvwxyz012345' })
    assert.deepEqual(confirmed, { ok: false, error: 'contains_secret' })
    assert.ok(await env.store.getPending(proposed.id), '候选必须保留')

    const after = await readAllTexts(env.dataDir)
    assert.deepEqual(
      after.map((item) => item.text),
      before.map((item) => item.text),
      '确认被拒绝时磁盘内容不能改变',
    )
    for (const item of after) assert.ok(!item.text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))
  } finally {
    await env.cleanup()
  }
})
