/**
 * 存储层：数据目录里所有文件的读写都经过这里。
 *
 * 目录结构（提示词 §4.1）：
 * ```
 * <dataDir>/settings.json          用户开关（界面里改）
 * <dataDir>/memory/YYYY-MM-DD.md   ★ 唯一事实来源，会被索引
 * <dataDir>/views/*.md             派生视图，每次变更后重新生成，不索引、不手改
 * <dataDir>/pending/<id>.json      待确认候选；在 memory/ 之外，所以索引器永远扫不到
 * <dataDir>/index/                 派生索引与缓存，可整个删掉重建
 * ```
 *
 * 关键约束：
 * - 读写都串行（同一 store 实例内的一条 Promise 队列），避免并发确认时丢更新。
 * - 写文件一律原子写（见 atomic.js）。
 * - **只读操作不能创建目录**：记忆没开启时，任何对话都不应该产生文件。
 * - 解析损坏时隔离到 index/quarantine/，其余照常读；不崩溃、不丢原文。
 * - 本文件不 import DSH，只用 node 内置模块与 src/ 里的纯函数。
 */

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { atomicWriteFile, removeFile } from './atomic.js'
import { resolveStorageCipher } from './cipher.js'
import { nowIso, validateMemoryRecord, validatePendingRecord } from './model.js'
import {
  MEMORY_FILE_PATTERN,
  VIEW_NAMES,
  parseDocument,
  renderViews,
  serializeDocument,
} from './markdown.js'

/** settings.json 的默认值。enabled 默认 false：没开启之前什么都不写。 */
export const DEFAULT_SETTINGS = Object.freeze({ version: 1, enabled: false, normalMode: 'confirm' })

/** 普通条目的确认方式。 */
export const NORMAL_MODES = Object.freeze(['confirm', 'auto'])

/** settings.json 允许的字段。 */
export const SETTINGS_FIELDS = Object.freeze(['version', 'enabled', 'normalMode'])

const MEMORY_DIR = 'memory'
const VIEWS_DIR = 'views'
const PENDING_DIR = 'pending'
const INDEX_DIR = 'index'
const QUARANTINE_DIR = 'quarantine'
const SETTINGS_FILE = 'settings.json'

/** 本地日期（按确认当天分文件）。timeZone 只给测试用，默认用系统时区。 */
export function localDateOf(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('localDateOf 需要合法时间')
  if (timeZone) {
    // en-CA 的日期格式就是 YYYY-MM-DD。
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  }
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSettings(raw) {
  if (!isPlainObject(raw)) throw new Error('settings 必须是对象')
  const unknown = Object.keys(raw).filter((key) => !SETTINGS_FIELDS.includes(key))
  if (unknown.length > 0) throw new Error(`settings 里有未知字段 ${unknown.join(', ')}`)
  const version = raw.version === undefined ? DEFAULT_SETTINGS.version : raw.version
  if (version !== 1) throw new Error('settings.version 只支持 1')
  const enabled = raw.enabled === undefined ? DEFAULT_SETTINGS.enabled : raw.enabled
  if (typeof enabled !== 'boolean') throw new Error('settings.enabled 必须是布尔值')
  const normalMode = raw.normalMode === undefined ? DEFAULT_SETTINGS.normalMode : raw.normalMode
  if (!NORMAL_MODES.includes(normalMode)) throw new Error('settings.normalMode 只能是 confirm | auto')
  return { version, enabled, normalMode }
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.created_at !== right.created_at) return left.created_at.localeCompare(right.created_at)
    return left.id.localeCompare(right.id)
  })
}

/**
 * 创建存储层。
 * @param {{
 *   dataDir: string,
 *   pendingTtlHours?: number,
 *   maxContentChars?: number,
 *   clock?: () => Date,
 *   timeZone?: string,
 *   fs?: object,
 * }} options
 */
export function createStore(options) {
  const {
    dataDir,
    pendingTtlHours = 24,
    maxContentChars = 280,
    clock = () => new Date(),
    timeZone,
    fs = fsp,
    cipher: cipherOption = null,
    defaultSettings = DEFAULT_SETTINGS,
  } = options ?? {}
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createStore 需要 dataDir')
  // 存储加密接口：当前恒等实现（明文，依赖系统磁盘加密）；将来换成系统密钥实现时不改调用方。
  const cipher = resolveStorageCipher({ cipher: cipherOption })

  const paths = {
    root: dataDir,
    settings: join(dataDir, SETTINGS_FILE),
    memory: join(dataDir, MEMORY_DIR),
    views: join(dataDir, VIEWS_DIR),
    pending: join(dataDir, PENDING_DIR),
    index: join(dataDir, INDEX_DIR),
    quarantine: join(dataDir, INDEX_DIR, QUARANTINE_DIR),
  }

  // 串行队列：同一实例上的所有读写按提交顺序执行。
  let chain = Promise.resolve()
  function run(task) {
    const next = chain.then(task, task)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function ensureDirs() {
    await fs.mkdir(paths.root, { recursive: true })
    await Promise.all([
      fs.mkdir(paths.memory, { recursive: true }),
      fs.mkdir(paths.views, { recursive: true }),
      fs.mkdir(paths.pending, { recursive: true }),
      fs.mkdir(paths.index, { recursive: true }),
      fs.mkdir(paths.quarantine, { recursive: true }),
    ])
  }

  async function readDir(path) {
    try {
      return await fs.readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  /** 读文本文件：先经过 StorageCipher 解密（恒等实现时等于直接读 UTF-8）。 */
  async function readText(file) {
    const bytes = await fs.readFile(file)
    const plain = await cipher.decrypt(bytes)
    return Buffer.isBuffer(plain) ? plain.toString('utf8') : Buffer.from(plain).toString('utf8')
  }

  /** 原子写文本文件：先经过 StorageCipher 加密，再走临时文件 + rename。 */
  async function writeText(file, text) {
    const bytes = await cipher.encrypt(Buffer.from(String(text), 'utf8'))
    await atomicWriteFile(file, bytes, { fs })
  }

  async function readSettingsState() {
    let text
    try {
      text = await readText(paths.settings)
    } catch (error) {
      if (error?.code === 'ENOENT') return { settings: normalizeSettings(defaultSettings), exists: false, invalid: false }
      throw error
    }
    try {
      return { settings: normalizeSettings(JSON.parse(text)), exists: true, invalid: false }
    } catch {
      // settings.json 坏掉时退回默认值（enabled=false）——失败要往安全的方向倒。
      return { settings: { ...DEFAULT_SETTINGS }, exists: true, invalid: true }
    }
  }

  async function quarantineRaw(kind, raw, extension) {
    const name = `${kind}-${shortHash(raw)}.${extension}`
    try {
      await ensureDirs()
      await writeText(join(paths.quarantine, name), raw)
      return name
    } catch {
      // 隔离失败也不能让读取崩溃；这块内容下次读还会再尝试隔离。
      return null
    }
  }

  async function cleanupExpiredPendingLocked() {
    const entries = await readDir(paths.pending)
    const now = clock().getTime()
    const ttlMs = pendingTtlHours * 60 * 60 * 1000
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const file = join(paths.pending, entry.name)
      let expired = false
      try {
        const raw = await readText(file)
        const parsed = JSON.parse(raw)
        const created = new Date(parsed?.created_at).getTime()
        expired = !Number.isFinite(created) || now - created > ttlMs
      } catch {
        // 坏 JSON：隔离原文并清掉，否则每次读取都会重复报错。
        let raw = ''
        try {
          raw = await readText(file)
        } catch {
          raw = ''
        }
        await quarantineRaw('pending', raw, 'json')
        await removeFile(file, { fs })
        removed += 1
        continue
      }
      if (expired) {
        await removeFile(file, { fs })
        removed += 1
      }
    }
    return removed
  }

  async function listPendingLocked() {
    await cleanupExpiredPendingLocked()
    const entries = await readDir(paths.pending)
    const items = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const raw = await readText(join(paths.pending, entry.name))
        const checked = validatePendingRecord(JSON.parse(raw), { maxContentChars })
        if (!checked.ok) throw new Error(checked.error)
        items.push(checked.value)
      } catch {
        // 坏候选：隔离并清掉（cleanupExpiredPendingLocked 已经处理过一轮，这里兜底）。
        let raw = ''
        try {
          raw = await readText(join(paths.pending, entry.name))
        } catch {
          raw = ''
        }
        await quarantineRaw('pending', raw, 'json')
        await removeFile(join(paths.pending, entry.name), { fs }).catch(() => {})
      }
    }
    return sortRecords(items)
  }

  async function readMemoryFilesLocked() {
    const entries = await readDir(paths.memory)
    const files = entries
      .filter((entry) => entry.isFile() && MEMORY_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    const records = []
    const quarantined = []
    for (const name of files) {
      let text
      try {
        text = await readText(join(paths.memory, name))
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      const parsed = parseDocument(text, { maxContentChars })
      for (const record of parsed.records) records.push(record)
      for (const broken of parsed.quarantined) {
        quarantined.push({ file: name, ...broken })
        await quarantineRaw('block', broken.raw, 'md')
      }
    }
    return { records: sortRecords(records), quarantined, files }
  }

  async function writeViewsLocked(records) {
    const views = renderViews(records)
    await fs.mkdir(paths.views, { recursive: true })
    for (const name of VIEW_NAMES) {
      await writeText(join(paths.views, name), views[name])
    }
  }

  async function appendRecordLocked(record) {
    await ensureDirs()
    // 按**确认当天**的本地日期分文件（提示词 §4.1）。
    const fileName = `${localDateOf(clock(), timeZone)}.md`
    const file = join(paths.memory, fileName)
    let existing = ''
    try {
      existing = await readText(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const block = `${serializeDocument([record])}`
    const nextText = existing.trim() === '' ? block : `${existing.replace(/\s+$/, '')}\n\n${block}`
    await writeText(file, nextText)
    return fileName
  }

  async function rewriteMemoryFileLocked(fileName, records) {
    const file = join(paths.memory, fileName)
    if (records.length === 0) {
      await removeFile(file, { fs })
      return
    }
    await writeText(file, serializeDocument(records))
  }

  async function updateMemoryContentLocked(id, content, options) {
    const editedByUser = options?.edited_by_user === true
    const { records, files } = await readMemoryFilesLocked()
    if (!records.some((record) => record.id === id)) return { ok: false, error: 'not_found' }
    for (const fileName of files) {
      const text = await readText(join(paths.memory, fileName))
      const parsed = parseDocument(text, { maxContentChars })
      if (!parsed.records.some((record) => record.id === id)) continue
      const nextRecords = parsed.records.map((record) =>
        record.id === id
          ? {
              ...record,
              content,
              updated_at: nowIso(clock),
              edited_by_user: editedByUser,
              // 敏感度只升不降由调用方（consent.update）判定后传进来；这里只做字段落盘。
              sensitivity: options?.sensitivity ?? record.sensitivity,
              reasons: options?.reasons ?? record.reasons,
            }
          : record,
      )
      const updated = nextRecords.find((record) => record.id === id)
      const checked = validateMemoryRecord(updated, { maxContentChars })
      if (!checked.ok) return { ok: false, error: 'invalid' }
      await rewriteMemoryFileLocked(fileName, nextRecords)
      const all = await readMemoryFilesLocked()
      await writeViewsLocked(all.records)
      return { ok: true, record: checked.value }
    }
    return { ok: false, error: 'not_found' }
  }

  async function deleteMemoryLocked(id) {
    const { files } = await readMemoryFilesLocked()
    for (const fileName of files) {
      const text = await readText(join(paths.memory, fileName))
      const parsed = parseDocument(text, { maxContentChars })
      if (!parsed.records.some((record) => record.id === id)) continue
      const nextRecords = parsed.records.filter((record) => record.id !== id)
      await rewriteMemoryFileLocked(fileName, nextRecords)
      // This cache may belong to an inactive semantic backend. A later switch
      // to keyword-only must not leave deleted vectors on disk indefinitely.
      await removeFile(join(paths.index, 'qwen-vectors.json'), { fs })
      const all = await readMemoryFilesLocked()
      await writeViewsLocked(all.records)
      return { ok: true }
    }
    return { ok: false, error: 'not_found' }
  }

  return {
    paths,

    /** 合并串行队列（给需要把多个步骤按顺序排队的调用方用；不要在内部再调用公开方法，否则会死锁）。 */
    run,

    /** 只读：设置。坏掉时返回默认值 + invalid 标记。 */
    async readSettingsState() {
      return run(readSettingsState)
    },

    /** 只读：设置（只要值）。 */
    async readSettings() {
      return run(async () => (await readSettingsState()).settings)
    },

    /** 改设置（合并 patch），返回新设置。会创建数据目录。 */
    async writeSettings(patch) {
      if (!isPlainObject(patch)) throw new Error('writeSettings 需要对象')
      return run(async () => {
        const current = (await readSettingsState()).settings
        const next = normalizeSettings({ ...current, ...patch })
        await ensureDirs()
        await writeText(paths.settings, `${JSON.stringify(next, null, 2)}\n`)
        return next
      })
    },

    /** 待确认候选（顺带清理过期与损坏的候选）。不创建目录之外的任何东西。 */
    async listPending() {
      return run(listPendingLocked)
    },

    /** 单个候选。 */
    async getPending(id) {
      return run(async () => {
        const items = await listPendingLocked()
        return items.find((item) => item.id === id) ?? null
      })
    },

    /** 待确认候选数量（不触发清理之外的写操作）。 */
    async countPending() {
      return run(async () => (await listPendingLocked()).length)
    },

    /** 写入一条候选（会创建数据目录）。 */
    async addPending(candidate) {
      const checked = validatePendingRecord(candidate, { maxContentChars })
      if (!checked.ok) throw new Error(`候选字段不合法：${checked.error}`)
      return run(async () => {
        await ensureDirs()
        await cleanupExpiredPendingLocked()
        await writeText(join(paths.pending, `${checked.value.id}.json`), `${JSON.stringify(checked.value, null, 2)}\n`)
        return checked.value
      })
    },

    /** 删除一条候选（用户点"不用"时调用）。删不掉就抛错，由调用方报告。 */
    async removePending(id) {
      return run(async () => {
        const file = join(paths.pending, `${id}.json`)
        await removeFile(file, { fs })
        return true
      })
    },

    /** 全部已确认记忆（只读；损坏块会被隔离，不崩溃、不丢原文）。 */
    async listMemories() {
      return run(async () => {
        const { records, quarantined } = await readMemoryFilesLocked()
        return { records, quarantined }
      })
    },

    /** 单条记忆。 */
    async getMemory(id) {
      return run(async () => {
        const { records } = await readMemoryFilesLocked()
        return records.find((record) => record.id === id) ?? null
      })
    },

    /** 把一条已确认记忆追加进 memory/YYYY-MM-DD.md，并重新生成视图。返回文件名。 */
    async addMemory(record) {
      const checked = validateMemoryRecord(record, { maxContentChars })
      if (!checked.ok) throw new Error(`记忆字段不合法：${checked.error}`)
      return run(async () => {
        const existing = await readMemoryFilesLocked()
        const saved = existing.records.find(item => item.id === checked.value.id)
        if (saved) {
          await writeViewsLocked(existing.records)
          return { record: saved, existing: true }
        }
        const fileName = await appendRecordLocked(checked.value)
        const { records } = await readMemoryFilesLocked()
        await writeViewsLocked(records)
        return { record: checked.value, fileName }
      })
    },

    /** 修改一条记忆的文字（管理界面用）。 */
    async updateMemoryContent(id, content, options = {}) {
      return run(() => updateMemoryContentLocked(id, content, options))
    },

    /** 删除一条记忆。返回 { ok, error }，不抛业务错误。 */
    async deleteMemory(id) {
      return run(() => deleteMemoryLocked(id))
    },

    /** 删除全部：记忆、候选、视图、索引、隔离区；保留 settings.json。 */
    async deleteAll() {
      return run(async () => {
        let deleted = 0
        for (const fileName of (await readDir(paths.memory)).filter((entry) => entry.isFile() && MEMORY_FILE_PATTERN.test(entry.name))) {
          await removeFile(join(paths.memory, fileName.name), { fs })
          deleted += 1
        }
        for (const entry of (await readDir(paths.pending)).filter((entry) => entry.isFile())) {
          await removeFile(join(paths.pending, entry.name), { fs })
        }
        for (const viewName of VIEW_NAMES) await removeFile(join(paths.views, viewName), { fs })
        for (const entry of (await readDir(paths.index)).filter((item) => item.isFile())) {
          await removeFile(join(paths.index, entry.name), { fs })
        }
        for (const entry of (await readDir(paths.quarantine)).filter((item) => item.isFile())) {
          await removeFile(join(paths.quarantine, entry.name), { fs })
        }
        return { deleted }
      })
    },

    /** 重新生成派生视图（不读索引）。 */
    async regenerateViews() {
      return run(async () => {
        const { records } = await readMemoryFilesLocked()
        if (records.length > 0 || (await readDir(paths.memory)).length > 0) await writeViewsLocked(records)
        return { views: VIEW_NAMES.length }
      })
    },

    /** 导出：一份 Markdown 和一份结构化数据，内容与已确认记忆一致。 */
    async exportAll() {
      return run(async () => {
        const { records } = await readMemoryFilesLocked()
        return { markdown: serializeDocument(records), memories: records }
      })
    },

    /** 把读不了的文件/内容原文隔离到 index/quarantine/（幂等：同名文件覆盖）。 */
    async quarantine(kind, raw, extension = 'txt') {
      return run(() => quarantineRaw(kind, raw, extension))
    },
  }
}
