/**
 * 隐私回归 #8：不推断。
 *
 * 证明两件事：
 * 1. 模块没有任何"自动生成候选"的代码路径——关闭时/未调用 propose 时，数据目录里不会有候选；
 * 2. propose 只接受 Agent 传入的 content；推断类断言（"用户正在服用激素所以……"）会被判为敏感，
 *    即使 normalMode=auto 也必须逐条确认。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createMemoryTools } from '../../plugins/memory-consent/src/tools.js'

const PLUGIN_ROOT = fileURLToPath(new URL('../../plugins/memory-consent/', import.meta.url))
const FIXED = new Date('2026-11-10T03:12:00.000Z')

async function collectSources() {
  const files = []
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${rel}/`)
      else if (entry.name.endsWith('.js')) files.push({ rel, text: await readFile(join(dir, entry.name), 'utf8') })
    }
  }
  await walk(join(PLUGIN_ROOT, 'src'), 'src/')
  files.push({ rel: 'index.js', text: await readFile(join(PLUGIN_ROOT, 'index.js'), 'utf8') })
  return files.sort((left, right) => left.rel.localeCompare(right.rel))
}

function makeDeps(dataDir) {
  const store = createStore({ dataDir, clock: () => FIXED })
  const backend = {
    async add() {},
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
  })
  return { store, consent }
}

test('源码里没有任何自动捕获/摘要/推断/生成候选的代码路径', async () => {
  const sources = await collectSources()
  assert.ok(sources.length >= 10)
  const forbidden = [
    /auto[-_ ]?capture/i,
    /auto[-_ ]?extract/i,
    /summari[sz]e/i,
    /generateCandidate/i,
    /inferMemory/i,
    /inferFact/i,
    /extractMemory\b/,
    /extractFact/i,
    /analy[sz]eConversation/i,
    /chat\.completions/i,
    /model\.complete/i,
  ]
  for (const file of sources) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(file.text, pattern, `${file.rel} 不应包含 ${pattern}`)
    }
  }
})

test('候选只能由 Agent 调用 propose 产生：addPending 只在 consent.js 里被调用', async () => {
  const sources = await collectSources()
  const callers = sources.filter((file) => file.text.includes('.addPending(')).map((file) => file.rel)
  assert.deepEqual(callers, ['src/consent.js'], '除了 consent.propose，没有任何代码路径能写候选')
  const proposeCallers = sources.filter((file) => /\.propose\s*\(/.test(file.text)).map((file) => file.rel)
  assert.deepEqual(proposeCallers, ['src/tools.js'], '只有工具层（Agent 调用）能触发 propose')
})

test('不调用 propose 时：即使记忆已开启且 normalMode=auto，也不会产生任何候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-no-inference-'))
  const dataDir = join(root, 'memory-data')
  try {
    const { store, consent } = makeDeps(dataDir)
    await store.writeSettings({ enabled: true, normalMode: 'auto' })

    // 模拟"一轮普通对话"：只读状态、列候选、列记忆、检索。
    await consent.status()
    await consent.listPendingForUi()
    await consent.listMemories()
    await consent.recall({ query: '用户说过什么' })

    assert.deepEqual(await store.listPending(), [], '没有任何代码会自动生成候选')
    assert.deepEqual((await store.listMemories()).records, [])
    const pendingFiles = (await readdir(join(dataDir, 'pending'))).filter((name) => name.endsWith('.json'))
    assert.deepEqual(pendingFiles, [])
    const memoryFiles = (await readdir(join(dataDir, 'memory'))).filter((name) => name.endsWith('.md'))
    assert.deepEqual(memoryFiles, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('推断类断言被判为敏感：即使 normalMode=auto 也必须逐条确认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-inference-'))
  const dataDir = join(root, 'memory-data')
  try {
    const { store, consent } = makeDeps(dataDir)
    await store.writeSettings({ enabled: true, normalMode: 'auto' })

    const result = await consent.propose(
      {
        // 这是 Agent 根据用药推断出来的事实，不是用户自己说的。
        content: '用户正在服用激素所以最近情绪不太稳定',
        category: 'explicit',
        sensitivity_hint: 'normal',
        user_quote: '虚构原话：最近状态不太好',
        stated_by_user: true,
      },
      { sessionId: 'session-a' },
    )
    assert.equal(result.status, 'rejected_by_policy', '来源未核对时不自动保存整理内容')
    assert.match(result.message, /未能核对/)
    assert.deepEqual((await store.listMemories()).records, [])
    const pending = await store.listPending()
    assert.equal(pending.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('没有 stated_by_user:true 的推断内容直接被策略拒绝（不进入待确认队列）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-inference-policy-'))
  const dataDir = join(root, 'memory-data')
  try {
    const { store, consent } = makeDeps(dataDir)
    await store.writeSettings({ enabled: true, normalMode: 'auto' })
    const result = await consent.propose(
      {
        content: '用户正在服用激素所以最近情绪不太稳定',
        category: 'explicit',
        sensitivity_hint: 'normal',
        user_quote: '虚构原话',
      },
      { sessionId: 'session-a' },
    )
    assert.equal(result.status, 'rejected_by_policy')
    assert.deepEqual(await store.listPending(), [])
    assert.deepEqual((await store.listMemories()).records, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具层只有 propose/recall/status 三个工具，没有自动捕获类工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-tools-'))
  try {
    const { consent } = makeDeps(join(root, 'memory-data'))
    const tools = createMemoryTools({ consent })
    assert.deepEqual(tools.map((tool) => tool.name), ['propose_memory', 'recall_memory', 'memory_status'])
    for (const tool of tools) {
      assert.doesNotMatch(tool.name, /auto|capture|extract|infer/i)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
