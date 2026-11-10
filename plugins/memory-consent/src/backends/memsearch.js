/**
 * 可选的 memsearch 语义检索适配层（semantic）。
 *
 * 本机没有安装 memsearch、也无法在未获得项目所有者同意前安装，因此：
 * - 参数格式来自官方 MemSearch DSH 插件 0.1.8 的实际调用（[先例]），
 *   但「`--json-output` 顶层输出结构」「重复 index 会不会清掉旧 chunk」等仍是 [未核实]，
 *   所以解析层写得宽容（数组 / {results|items|matches|data} / 单个对象 / NDJSON 都接受），
 *   并在找不到 `mem_[0-9a-f-]{36}` 形式 id 时跳过该条（绝不猜）。
 * - 这里只做「调用命令行 + 解析 + 标脏」；任何测试都用注入的假 exec，不依赖真实 memsearch。
 *
 * 安全约束（docs/DEV_STANDARDS.md §9）：
 * - 只用 node:child_process 的 execFile，参数数组、shell: false，绝不经过 shell 拼接。
 * - 错误信息只包含稳定 code 与退出码，绝不包含查询原文或记忆内容（不把 exec 的原始 message 往上抛）。
 * - health() 不 spawn 子进程，只用 fs.access 判断 command 是否存在且可执行。
 * - 不输出日志。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

export const MEMSEARCH_BACKEND_NAME = 'memsearch'
export const DEFAULT_PROVIDER = 'onnx'
export const DEFAULT_TIMEOUT_MS = 8000
export const MEMSEARCH_FAILED = 'MEMSEARCH_FAILED'
export const MEMSEARCH_TIMEOUT = 'MEMSEARCH_TIMEOUT'
export const MEMSEARCH_ABORTED = 'MEMSEARCH_ABORTED'
/** 子进程 stdout 上限（索引命令在极端情况下会输出不少内容，给足余量但仍设上限）。 */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
/** 只认 36 字符的 mem_ id（crypto.randomUUID 的字符串长度正好 36）。 */
const MEMORY_ID_PATTERN = /mem_[0-9a-f-]{36}/
const DEFAULT_TOP_K = 5

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 构造带稳定 code 的错误；message 只含 code 与安全细节（不出现查询/记忆内容）。 */
function backendError(code, detail) {
  const error = new Error(detail ? `${code} (${detail})` : code)
  error.code = code
  return error
}

function abortError() {
  const error = backendError(MEMSEARCH_ABORTED)
  error.name = 'AbortError'
  return error
}

/**
 * 集合名由数据目录路径的哈希派生，保证不同数据目录互不可见、且同一目录名稳定。
 * Windows 路径大小写不敏感，所以统一转小写并把反斜杠归一成斜杠，避免同一目录产生两个集合。
 */
export function collectionNameFor(dataDir) {
  if (!isNonEmptyString(dataDir)) throw new TypeError('collectionNameFor: dataDir 必须是非空字符串')
  let normalized = resolve(dataDir).replace(/\\/g, '/')
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex')
  return `chengmeng_${digest.slice(0, 16)}`
}

/**
 * index 子命令参数：index <memoryDir> [--provider onnx] [--milvus-uri <uri>] --default-collection <collection>
 * 返回数组，调用方直接交给 execFile（不拼 shell）。
 */
export function buildIndexArgs({ memoryDir, provider, milvusUri, collection } = {}) {
  if (!isNonEmptyString(memoryDir)) throw new TypeError('buildIndexArgs: memoryDir 必须是非空字符串')
  if (!isNonEmptyString(collection)) throw new TypeError('buildIndexArgs: collection 必须是非空字符串')
  const args = ['index', memoryDir]
  if (isNonEmptyString(provider)) args.push('--provider', provider)
  if (isNonEmptyString(milvusUri)) args.push('--milvus-uri', milvusUri)
  args.push('--default-collection', collection)
  return args
}

/**
 * search 子命令参数：
 * search <query> --top-k <n> --json-output [--provider onnx] [--milvus-uri <uri>] --default-collection <collection>
 */
export function buildSearchArgs({ query, topK, provider, milvusUri, collection } = {}) {
  if (typeof query !== 'string' || query === '') throw new TypeError('buildSearchArgs: query 必须是非空字符串')
  if (!Number.isInteger(topK) || topK < 1) throw new RangeError('buildSearchArgs: topK 必须是正整数')
  if (!isNonEmptyString(collection)) throw new TypeError('buildSearchArgs: collection 必须是非空字符串')
  const args = ['search', query, '--top-k', String(topK), '--json-output']
  if (isNonEmptyString(provider)) args.push('--provider', provider)
  if (isNonEmptyString(milvusUri)) args.push('--milvus-uri', milvusUri)
  args.push('--default-collection', collection)
  return args
}

/** 默认执行器：execFile 参数数组、shell: false，带超时 kill 与外部 signal 取消。 */
function defaultExec(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env, signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal && signal.aborted) {
      rejectPromise(abortError())
      return
    }
    let settled = false
    let timedOut = false
    let timer = null
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    function onAbort() {
      try {
        child.kill()
      } catch {
        /* 进程可能已经退出 */
      }
      settle(rejectPromise, abortError())
    }
    const child = execFile(
      command,
      args,
      { env, shell: false, windowsHide: true, maxBuffer: MAX_STDOUT_BYTES, encoding: 'utf8' },
      (error, stdout) => {
        if (timedOut) {
          settle(rejectPromise, backendError(MEMSEARCH_TIMEOUT, `timeout_ms=${timeoutMs}`))
          return
        }
        if (error) {
          const exitCode = Number.isInteger(error.code) ? error.code : null
          settle(rejectPromise, backendError(MEMSEARCH_FAILED, exitCode === null ? undefined : `exit_code=${exitCode}`))
          return
        }
        settle(resolvePromise, { stdout: String(stdout ?? ''), code: 0 })
      },
    )
    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* 进程可能已经退出 */
      }
      settle(rejectPromise, backendError(MEMSEARCH_TIMEOUT, `timeout_ms=${timeoutMs}`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 宽容地解析一次 JSON；失败返回 undefined（与 JSON 里的 null 区分开）。 */
function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** JSON.parse("null") 也是合法 JSON，这里统一把非对象结果折叠成 undefined。 */
function parseJsonOrUndefined(text) {
  const parsed = tryParseJson(text)
  return parsed === null ? undefined : parsed
}

/**
 * 解析 search --json-output。
 * 官方插件文档只给出单条结果的字段（content / source / heading / score / chunk_hash），
 * 顶层结构是 [未核实]，所以这里接受多种常见形状；完全无法识别时返回空数组。
 */
function parseSearchOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text === '') return []
  const parsed = tryParseJson(text)
  if (parsed !== null && parsed !== undefined) {
    if (Array.isArray(parsed)) return parsed
    if (isPlainObject(parsed)) {
      for (const key of ['results', 'items', 'matches', 'data', 'hits']) {
        if (Array.isArray(parsed[key])) return parsed[key]
      }
      return [parsed]
    }
    return []
  }
  // 兜底：逐行 JSON（NDJSON），有些工具会这么输出。
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsedLine = tryParseJson(trimmed)
    if (parsedLine === undefined || parsedLine === null) return []
    if (Array.isArray(parsedLine)) rows.push(...parsedLine)
    else if (isPlainObject(parsedLine)) rows.push(parsedLine)
  }
  return rows
}

/** 从 heading 里抽 mem id；抽不到返回 null（该条命中直接跳过，不猜）。 */
function extractMemoryId(heading) {
  if (typeof heading !== 'string') return null
  const matched = heading.match(MEMORY_ID_PATTERN)
  return matched ? matched[0] : null
}

/** 把注入的时钟安全地转成 ISO 8601 UTC 字符串。 */
function nowIso(clock) {
  try {
    const value = typeof clock === 'function' ? clock() : new Date()
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return new Date().toISOString()
    return date.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/**
 * 创建 memsearch 语义后端。
 * - command 为空（或只含空白）→ 返回 null：未配置时整个后端不存在。
 * - exec 可注入，签名 `async (command, args, { timeoutMs, env, signal }) -> { stdout, code }`，
 *   抛错时按其 code/exitCode 归类；测试全部使用假 exec。
 *
 * @returns {null | {
 *   name: string, add(record): Promise<void>, remove(id): Promise<void>,
 *   search(query, options): Promise<Array<{ id: string, score: number, matched_by: 'semantic' }>>,
 *   rebuild(records): Promise<{ ok: boolean, docs: number }>,
 *   reindex(): Promise<{ ok: boolean }>,
 *   health(): Promise<object>,
 * }}
 */
export function createMemsearchBackend({
  command,
  provider = DEFAULT_PROVIDER,
  milvusUri = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  collection,
  memoryDir,
  clock = () => new Date(),
  exec = null,
} = {}) {
  const normalizedCommand = isNonEmptyString(command) ? command.trim() : ''
  if (normalizedCommand === '') return null
  if (!isNonEmptyString(memoryDir)) {
    throw new TypeError('memsearch backend: memoryDir 必须是非空字符串')
  }
  const resolvedCollection = isNonEmptyString(collection) ? collection.trim() : collectionNameFor(memoryDir)
  const execImpl = typeof exec === 'function' ? exec : defaultExec
  const resolvedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS
  const state = {
    /** 内存索引与 memoryDir 是否可能不一致；初始为脏，保证第一次 search 前先 index 一次。 */
    dirty: true,
    last_indexed_at: null,
    last_error_code: null,
  }

  /** 索引命令要带 MEMSEARCH_NO_WATCH=1（官方插件先例：避免常驻 watch 进程）。 */
  const indexEnv = { ...process.env, MEMSEARCH_NO_WATCH: '1' }

  /** 把任意失败归一成稳定 code 的错误；绝不透传原始 message（可能含命令行/查询原文）。 */
  function sanitizeError(error) {
    state.last_error_code = null
    const code = error && error.code
    if (code === MEMSEARCH_TIMEOUT || code === 'ETIMEDOUT') {
      state.last_error_code = MEMSEARCH_TIMEOUT
      return backendError(MEMSEARCH_TIMEOUT, `timeout_ms=${resolvedTimeout}`)
    }
    if (code === MEMSEARCH_ABORTED || (error && error.name === 'AbortError') || code === 'ABORT_ERR') {
      state.last_error_code = MEMSEARCH_ABORTED
      return abortError()
    }
    const exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : Number.isInteger(code) ? code : null
    state.last_error_code = MEMSEARCH_FAILED
    return backendError(MEMSEARCH_FAILED, exitCode === null ? undefined : `exit_code=${exitCode}`)
  }

  /**
   * 执行一次子命令：包装 exec 的超时/中止与错误归类，并检查返回码。
   * 返回 stdout 字符串（index 命令的输出不落日志、不使用）。
   */
  async function runCommand(args, { env, signal } = {}) {
    if (signal && signal.aborted) throw abortError()
    let timer = null
    const timeoutPromise = new Promise((_, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(backendError(MEMSEARCH_TIMEOUT, `timeout_ms=${resolvedTimeout}`)), resolvedTimeout)
      if (typeof timer.unref === 'function') timer.unref()
    })
    const execPromise = Promise.resolve()
      .then(() => execImpl(normalizedCommand, [...args], { timeoutMs: resolvedTimeout, env: env ?? process.env, signal }))
      .catch((error) => {
        throw sanitizeError(error)
      })
    try {
      const outcome = await Promise.race([execPromise, timeoutPromise])
      const exitCode = outcome && outcome.code
      if (Number.isInteger(exitCode) && exitCode !== 0) {
        throw backendError(MEMSEARCH_FAILED, `exit_code=${exitCode}`)
      }
      return typeof outcome?.stdout === 'string' ? outcome.stdout : String(outcome?.stdout ?? '')
    } catch (error) {
      // 超时/中止已经过 sanitize；这里兜住 exec 同步抛错等意外情况。
      if (error && (error.code === MEMSEARCH_TIMEOUT || error.code === MEMSEARCH_ABORTED || error.code === MEMSEARCH_FAILED)) throw error
      throw sanitizeError(error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 全量重建语义索引（memsearch index <memoryDir>）。失败会抛稳定 code 的错误，dirty 保持为 true。 */
  async function reindex() {
    const args = buildIndexArgs({ memoryDir, provider, milvusUri, collection: resolvedCollection })
    await runCommand(args, { env: indexEnv })
    state.dirty = false
    state.last_indexed_at = nowIso(clock)
    state.last_error_code = null
    return { ok: true }
  }

  /** add 只标脏：memsearch 的索引命令以目录为单位，增量没有任何可靠先例，全量重建更安全。 */
  async function add(record) {
    if (!isPlainObject(record) || typeof record.id !== 'string' || record.id === '') {
      throw new TypeError('memsearch backend: record.id 必须是非空字符串')
    }
    state.dirty = true
  }

  /** remove 只标脏，理由同 add。真正的删除靠「从 memoryDir 删掉 Markdown 块后的重新 index」。 */
  async function remove(id) {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('memsearch backend: remove 的 id 必须是非空字符串')
    }
    state.dirty = true
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Array<{ id: string, score: number, matched_by: 'semantic' }>>}
   */
  async function search(query, options = {}) {
    if (typeof query !== 'string' || query === '') return []
    const signal = options?.signal
    if (signal && signal.aborted) throw abortError()
    // 索引和 memoryDir 可能不一致时先重建，避免返回已删除内容的命中。
    if (state.dirty) await reindex()
    const topK = Number.isInteger(options.limit) && options.limit >= 1 ? options.limit : DEFAULT_TOP_K
    const args = buildSearchArgs({ query, topK, provider, milvusUri, collection: resolvedCollection })
    const stdout = await runCommand(args, { signal })
    const rows = parseSearchOutput(stdout)
    const results = []
    const seen = new Set()
    for (const row of rows) {
      if (!isPlainObject(row)) continue
      const id = extractMemoryId(row.heading)
      if (id === null || seen.has(id)) continue
      seen.add(id)
      const score = Number(row.score)
      // matched_by 用检索语义名 'semantic'（记忆模块 §6.3 的取值只有 keyword｜semantic）；
      // 后端自己的名字仍是 'memsearch'，由 health()/name 暴露。
      results.push({ id, score: Number.isFinite(score) ? score : 0, matched_by: 'semantic' })
    }
    results.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return results.slice(0, topK)
  }

  /** 与其他后端保持相同签名；memsearch 直接扫 memoryDir，records 参数只用于计数。 */
  async function rebuild(records) {
    await reindex()
    const docs = Array.isArray(records) ? records.length : 0
    return { ok: true, docs }
  }

  /** 只读健康状态：不 spawn 子进程，只检查 command 是否可执行。 */
  async function health() {
    let commandAvailable = false
    try {
      await access(normalizedCommand, fsConstants.X_OK)
      commandAvailable = true
    } catch {
      commandAvailable = false
    }
    const payload = {
      ok: commandAvailable,
      backend: MEMSEARCH_BACKEND_NAME,
      command_available: commandAvailable,
      collection: resolvedCollection,
      dirty: state.dirty,
      last_indexed_at: state.last_indexed_at,
    }
    if (!commandAvailable) payload.reason = 'command_unavailable'
    else if (state.last_error_code) payload.reason = state.last_error_code
    return payload
  }

  return {
    name: MEMSEARCH_BACKEND_NAME,
    add,
    remove,
    search,
    rebuild,
    reindex,
    health,
  }
}
