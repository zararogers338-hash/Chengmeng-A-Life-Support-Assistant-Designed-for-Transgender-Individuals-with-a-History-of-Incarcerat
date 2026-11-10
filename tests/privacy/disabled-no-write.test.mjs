/**
 * 隐私回归 #1：总开关关闭时，propose / recall / status 都不写任何文件。
 * 通过调用前后的递归目录快照对比证明"一个字节都没变"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../../plugins/memory-consent/src/store.js'
import { createConsentService } from '../../plugins/memory-consent/src/consent.js'
import { createMemoryTools } from '../../plugins/memory-consent/src/tools.js'

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

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
        output.push(`file:${rel}:${(await readFile(join(dir, entry.name))).toString('utf8')}`)
      }
    }
  }
  await walk(root, '')
  return output
}

function makeDeps(dataDir) {
  const backendCalls = { add: [], remove: [], rebuild: [], search: [] }
  const backend = {
    async add(record) {
      backendCalls.add.push(record)
    },
    async remove(id) {
      backendCalls.remove.push(id)
    },
    async search() {
      return []
    },
    async rebuild(records) {
      backendCalls.rebuild.push(records)
      return { ok: true }
    },
    async health() {
      return { ok: true, backend: 'keyword' }
    },
  }
  const searchCalls = []
  const search = {
    async searchMemories(args) {
      searchCalls.push(args)
      return { results: [], backend_used: 'keyword', degraded: false }
    },
  }
  const store = createStore({ dataDir, clock: () => new Date('2026-11-10T03:12:00.000Z') })
  const consent = createConsentService({ store, backend, search, clock: () => new Date('2026-11-10T03:12:00.000Z') })
  return { store, backend, backendCalls, search, searchCalls, consent }
}

test('关闭时：propose 返回 disabled，数据目录不存在（调用前后快照相同）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-disabled-'))
  const dataDir = join(root, 'memory-data')
  try {
    const { consent, backendCalls } = makeDeps(dataDir)
    const before = await snapshotDir(dataDir)
    assert.equal(await pathExists(dataDir), false)

    const proposed = await consent.propose(
      {
        content: '关闭状态下不该被记住的虚构内容',
        category: 'preference',
        sensitivity_hint: 'normal',
        user_quote: '这是虚构的用户原话',
        stated_by_user: true,
      },
      { sessionId: 'session-a' },
    )
    assert.equal(proposed.status, 'disabled')
    assert.deepEqual(await snapshotDir(dataDir), before, '关闭时 propose 不能创建/修改任何文件')
    assert.equal(await pathExists(dataDir), false)
    assert.equal(backendCalls.add.length, 0)

    const recalled = await consent.recall({ query: '虚构内容' })
    assert.equal(recalled.status, 'disabled')
    assert.deepEqual(recalled.results, [])
    assert.equal(backendCalls.search.length, 0, '关闭时不能碰索引')

    const status = await consent.status()
    assert.equal(status.enabled, false)
    assert.equal(status.pendingCount, 0)
    assert.deepEqual(await snapshotDir(dataDir), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('关闭时：工具层 propose_memory / recall_memory / memory_status 都不产生文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-privacy-disabled-tool-'))
  const dataDir = join(root, 'memory-data')
  try {
    const { consent } = makeDeps(dataDir)
    const tools = createMemoryTools({ consent })
    const proposeTool = tools.find((tool) => tool.name === 'propose_memory')
    const recallTool = tools.find((tool) => tool.name === 'recall_memory')
    const statusTool = tools.find((tool) => tool.name === 'memory_status')

    const proposed = JSON.parse(
      await proposeTool.execute(
        {
          content: '工具层关闭时不该写入的内容',
          category: 'preference',
          user_quote: '虚构原话',
          stated_by_user: true,
        },
        {},
      ),
    )
    assert.equal(proposed.status, 'disabled')

    assert.match(await recallTool.execute({ query: '任何内容' }, {}), /关闭/)
    const status = JSON.parse(await statusTool.execute({}, {}))
    assert.equal(status.enabled, false)

    assert.equal(await pathExists(dataDir), false, '关闭时工具调用不能创建数据目录')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
