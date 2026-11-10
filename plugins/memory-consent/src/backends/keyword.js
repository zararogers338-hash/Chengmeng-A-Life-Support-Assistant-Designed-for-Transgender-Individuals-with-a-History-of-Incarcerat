/**
 * 内置关键词检索后端（keyword，默认后端）。
 *
 * 设计要点（对应 docs/prompts/memory-module.md §6）：
 * - 纯 Node 内置模块：零依赖、不联网、不起子进程、不输出日志。
 * - 中文支持：CJK 连续段切成「单字 token + 相邻二元组（bigram）token」，
 *   所以「下周二」→ 下 / 周 / 二 / 下周 / 周二；拉丁字母与数字按非字母数字切分并转小写。
 * - 打分用 BM25（k1 = 1.2，b = 0.75），只返回 score > 0 的命中。
 * - 索引是派生数据：整个 `<dataDir>/index/keyword.json` 删掉后可由 rebuild() 全量重建。
 *   文件不存在或 JSON 损坏时绝不崩溃：isIndexed() = false、health().ok = false，
 *   health().reason 只写状态码（index_missing / index_corrupt / persist_failed），不含任何记忆内容。
 * - 写盘一律「同目录临时文件 + rename」，Windows 上 rename 可能被杀毒/索引服务短暂占用，重试 3 次；
 *   明确失败时删掉临时文件，不留半截文件，并作废旧索引（派生数据，强制下一次重建，
 *   避免重启后信任一个「看起来正常、实际缺条目」的旧索引）。索引里不存正文，只存由正文派生出的词频与文档元数据
 *   （id / category / created_at / 长度 / 词频）——派生索引本身仍有内容痕迹，所以它和数据目录一样
 *   受文件权限与磁盘加密保护。
 * - add/remove 时若磁盘索引从未成功加载过（缺失或损坏），只更新内存并把 isIndexed() 保持为 false，
 *   由上层调用 rebuild(records) 重建；绝不用残缺的内存索引去覆盖磁盘，避免「索引看起来正常但少了一半」。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const KEYWORD_BACKEND_NAME = 'keyword'
export const INDEX_RELATIVE_PATH = 'index/keyword.json'
export const INDEX_VERSION = 2
export const BM25_K1 = 1.2
export const BM25_B = 0.75
/**
 * 最低分数阈值：提示词 §6.3 要求"分数不够的不返回"。
 * BM25 的分数与语料规模/词频相关，0.2 是经验值：只命中一个高频单字（例如"我"）通常低于它，
 * 命中一个二字符 bigram 或稀有词通常高于它。hybrid 后端还会再叠加相对阈值。
 */
export const MIN_KEYWORD_SCORE = 0.2
/** Windows 上 rename 被短暂占用（杀毒、搜索索引）时的重试次数。 */
export const RENAME_ATTEMPTS = 3
/** 重试之间的等待毫秒数；测试里可以接受。 */
const RENAME_RETRY_DELAY_MS = 15

/** 默认文件系统实现；测试可注入 fsImpl 做故障注入。 */
const DEFAULT_IO = { mkdir, readFile, rename, unlink, writeFile }

// CJK 范围：日文假名、扩展 A、基本汉字、兼容表意文字、韩文音节。
const CJK_RANGES = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af'
/** 用于切分的总模式：CJK 连续段，或「一段拉丁字母/数字」。 */
const TOKEN_PATTERN = new RegExp(`[${CJK_RANGES}]+|[a-z0-9]+`, 'g')
/** 判断某个切分结果是不是纯 CJK 段。 */
const CJK_ONLY_PATTERN = new RegExp(`^[${CJK_RANGES}]+$`)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把文本切成检索 token。拼音/英文按词切，CJK 按单字 + 相邻 bigram 切。
 *
 * 重复 token 会被保留（BM25 需要词频），调用方要唯一化时自己 Set 一下。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const tokens = []
  const lowered = text.toLowerCase()
  for (const match of lowered.matchAll(TOKEN_PATTERN)) {
    const run = match[0]
    if (CJK_ONLY_PATTERN.test(run)) {
      // 单字：保证短查询（如「面」）也能命中。
      for (const char of run) tokens.push(char)
      // 相邻两字：保证「面试」不会把「有问题」里的「问」「题」也算成命中。
      for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
    } else {
      tokens.push(run)
    }
  }
  return tokens
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

/** 把 since/until 归一成毫秒时间戳；无法解析时返回 null。 */
function toTimestamp(value) {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** 把一条记忆记录压成索引文档（只存元数据与词频，不存正文）。 */
function buildIndexDoc(record) {
  const tokens = tokenize(record.content)
  const termFreq = new Map()
  for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
  const terms = {}
  for (const [term, frequency] of termFreq) terms[term] = frequency
  return {
    id: record.id,
    category: typeof record.category === 'string' ? record.category : '',
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
    source_time: record.source_time,
    sensitivity: record.sensitivity,
    length: tokens.length,
    terms,
  }
}

/** 校验从磁盘读到的索引结构；任何形状不对都视为损坏（不尝试猜测修复）。 */
function isIndexShape(value) {
  if (!isPlainObject(value)) return false
  if (value.version !== INDEX_VERSION) return false
  if (!Array.isArray(value.docs)) return false
  for (const doc of value.docs) {
    if (!isPlainObject(doc)) return false
    if (typeof doc.id !== 'string' || doc.id === '') return false
    if (typeof doc.length !== 'number' || !Number.isFinite(doc.length) || doc.length < 0) return false
    if (!isPlainObject(doc.terms)) return false
    for (const [term, frequency] of Object.entries(doc.terms)) {
      if (term === '' || !Number.isFinite(frequency) || frequency <= 0) return false
    }
    if (doc.category !== undefined && typeof doc.category !== 'string') return false
    if (doc.created_at !== undefined && typeof doc.created_at !== 'string') return false
  }
  return true
}

/**
 * 创建关键词后端。
 *
 * @param {object} params
 * @param {string} params.dataDir  数据目录；索引写到 <dataDir>/index/keyword.json
 * @param {object|null} [params.fsImpl]  可选的文件系统替身（测试故障注入用），缺省方法回退到 node:fs/promises
 * @param {() => Date} [params.clock]  时钟注入（测试用）
 */
export function createKeywordBackend({ dataDir, fsImpl = null, clock = () => new Date() } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('keyword backend: dataDir 必须是非空字符串')
  }
  const io = { ...DEFAULT_IO, ...(fsImpl ?? {}) }
  const indexPath = join(dataDir, INDEX_RELATIVE_PATH)
  const indexDir = dirname(indexPath)

  const state = {
    loaded: false,
    /** 磁盘索引是否可用且可信（成功加载或刚全量重建）。 */
    indexed: false,
    /** 是否允许把内存索引增量写回磁盘；加载失败时为 false，避免用残缺索引覆盖。 */
    canPersist: false,
    /** 状态码，只用于 health()，不含记忆内容。 */
    reason: undefined,
    built_at: null,
    docs: [],
  }
  let loadingPromise = null
  let tempFileCounter = 0

  /**
   * 从磁盘加载索引。永不抛：文件缺失/损坏都只记录状态。
   * 这是「整个删掉也能重建」的入口——删掉文件后 isIndexed() 为 false，上层会调 rebuild。
   */
  async function load() {
    state.loaded = true
    state.indexed = false
    state.canPersist = false
    let raw
    try {
      raw = await io.readFile(indexPath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        state.reason = 'index_missing'
      } else {
        state.reason = 'index_unreadable'
      }
      state.docs = []
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      state.reason = 'index_corrupt'
      state.docs = []
      return
    }
    if (!isIndexShape(parsed)) {
      state.reason = 'index_corrupt'
      state.docs = []
      return
    }
    state.docs = parsed.docs
    state.built_at = typeof parsed.built_at === 'string' ? parsed.built_at : null
    state.indexed = true
    state.canPersist = true
    state.reason = undefined
  }

  async function ensureLoaded() {
    if (state.loaded) return
    if (!loadingPromise) {
      loadingPromise = load().finally(() => {
        loadingPromise = null
      })
    }
    await loadingPromise
  }

  /**
   * 原子写索引：临时文件 → rename（失败重试 3 次）→ 失败时删掉临时文件。
   * 明确失败会抛错并让 isIndexed() 变成 false，但不会留下半截文件。
   */
  async function persist() {
    await io.mkdir(indexDir, { recursive: true })
    const builtAt = nowIso(clock)
    const payload = JSON.stringify({
      version: INDEX_VERSION,
      backend: KEYWORD_BACKEND_NAME,
      built_at: builtAt,
      docs: state.docs,
    })
    const tempPath = join(indexDir, `.keyword-${process.pid}-${tempFileCounter++}.tmp`)
    await io.writeFile(tempPath, payload, 'utf8')
    let lastError = null
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
      try {
        await io.rename(tempPath, indexPath)
        state.built_at = builtAt
        // 写盘成功即说明磁盘索引与内存一致（也覆盖「上次写失败、这次恢复」的情况）。
        state.indexed = true
        state.reason = undefined
        return
      } catch (error) {
        lastError = error
        if (attempt < RENAME_ATTEMPTS - 1) await delay(RENAME_RETRY_DELAY_MS)
      }
    }
    // 明确失败：清掉临时文件，磁盘上不留半截索引。
    try {
      await io.unlink(tempPath)
    } catch {
      /* 临时文件清理失败也不能掩盖原始错误 */
    }
    // 写失败说明磁盘索引已无法保证与事实一致。索引是派生数据（可整个删掉重建），
    // 所以这里主动作废旧索引，让下一次加载/检索明确走重建；
    // 否则重启后会加载一个「看起来正常、实际缺条目」的旧索引，造成静默召回丢失。
    try {
      await io.unlink(indexPath)
    } catch {
      /* 旧索引可能本来就不存在，或同样删不掉：只能如实报告失败状态 */
    }
    state.indexed = false
    state.reason = 'persist_failed'
    throw lastError ?? new Error('keyword index persist failed')
  }

  /** 把一条记录写入内存索引（同 id 覆盖）。 */
  function upsertDoc(record) {
    const doc = buildIndexDoc(record)
    const index = state.docs.findIndex((item) => item.id === doc.id)
    if (index >= 0) state.docs[index] = doc
    else state.docs.push(doc)
  }

  /** 增量写回；索引是派生数据，写失败不阻断业务，交给 health()/rebuild() 兜底。 */
  async function persistIncremental() {
    if (!state.canPersist) return
    try {
      await persist()
    } catch {
      // health() 会报 ok:false（reason=persist_failed），上层可据此重建索引。
    }
  }

  function assertRecord(record) {
    if (!isPlainObject(record) || typeof record.id !== 'string' || record.id === '') {
      throw new TypeError('keyword backend: record.id 必须是非空字符串')
    }
    if (typeof record.content !== 'string') {
      throw new TypeError('keyword backend: record.content 必须是字符串')
    }
  }

  /** 应用 categories / since / until 过滤（按索引里的记录元数据）。 */
  function matchesFilters(doc, filters) {
    const { categories, sinceTimestamp, untilTimestamp } = filters
    if (categories !== null && !categories.includes(doc.category)) return false
    if (sinceTimestamp !== null || untilTimestamp !== null) {
      const created = Date.parse(doc.created_at)
      if (Number.isNaN(created)) return false
      if (sinceTimestamp !== null && created < sinceTimestamp) return false
      if (untilTimestamp !== null && created > untilTimestamp) return false
    }
    return true
  }

  /**
   * BM25 打分。query 词去重后逐词累加；只保留 score > 0 的文档。
   * idf = ln(1 + (N - df + 0.5) / (df + 0.5))
   */
  function scoreDocs(docs, queryTokens) {
    const uniqueTerms = [...new Set(queryTokens)]
    if (docs.length === 0 || uniqueTerms.length === 0) return []
    const docCount = docs.length
    const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0)
    const averageLength = totalLength > 0 ? totalLength / docCount : 1
    const documentFrequency = new Map()
    for (const term of uniqueTerms) {
      let count = 0
      for (const doc of docs) if ((doc.terms[term] ?? 0) > 0) count += 1
      documentFrequency.set(term, count)
    }
    const scored = []
    for (const doc of docs) {
      const lengthNorm = BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength)
      let score = 0
      for (const term of uniqueTerms) {
        const frequency = doc.terms[term] ?? 0
        if (frequency <= 0) continue
        const df = documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
        score += (idf * (frequency * (BM25_K1 + 1))) / (frequency + lengthNorm)
      }
      if (score > 0 && score >= MIN_KEYWORD_SCORE) scored.push({ id: doc.id, score })
    }
    return scored
  }

  /**
   * @param {string} query
   * @param {{ categories?: string[]|string, since?: string|number|Date, until?: string|number|Date, limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Array<{ id: string, score: number, matched_by: 'keyword' }>>}
   */
  async function search(query, options = {}) {
    await ensureLoaded()
    const signal = options?.signal
    if (signal && signal.aborted) return []
    if (typeof query !== 'string' || query.trim() === '') return []

    let categories = null
    if (options.categories !== undefined && options.categories !== null) {
      const list = Array.isArray(options.categories) ? options.categories : [options.categories]
      const cleaned = list.filter((item) => typeof item === 'string' && item !== '')
      // 空数组等价于「不过滤」，避免调用方传 [] 时静默返回 0 条。
      if (cleaned.length > 0) categories = cleaned
    }
    const filters = {
      categories,
      sinceTimestamp: toTimestamp(options.since),
      untilTimestamp: toTimestamp(options.until),
    }

    const queryTokens = tokenize(query)
    const docsById = new Map(state.docs.map((doc) => [doc.id, doc]))
    const scored = scoreDocs(state.docs, queryTokens).filter((hit) => {
      const doc = docsById.get(hit.id)
      const dated = doc && options.timeField !== 'created' && doc.source_time ? { ...doc, created_at: doc.source_time } : doc
      return dated !== undefined && matchesFilters(dated, filters)
    })
    scored.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const results = scored.map((hit) => ({ id: hit.id, score: hit.score, matched_by: KEYWORD_BACKEND_NAME }))
    const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null
    return limit === null ? results : results.slice(0, limit)
  }

  /** 增量更新一条记录（同 id 覆盖）。 */
  async function add(record) {
    assertRecord(record)
    await ensureLoaded()
    upsertDoc(record)
    await persistIncremental()
  }

  /** 从索引里删掉一条记录。 */
  async function remove(id) {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('keyword backend: remove 的 id 必须是非空字符串')
    }
    await ensureLoaded()
    const before = state.docs.length
    state.docs = state.docs.filter((doc) => doc.id !== id)
    if (state.docs.length !== before) await persistIncremental()
  }

  /**
   * 全量重建：用给定记录重算索引并写 <dataDir>/index/keyword.json。
   * 写盘失败会抛出（索引不可用是明确失败），但不会留下半截文件。
   */
  async function rebuild(records) {
    if (!Array.isArray(records)) throw new TypeError('keyword backend: rebuild 需要记录数组')
    state.docs = records
      .filter((record) => isPlainObject(record) && typeof record.id === 'string' && record.id !== '' && typeof record.content === 'string')
      .map(buildIndexDoc)
    state.loaded = true
    state.canPersist = true
    await persist()
    state.indexed = true
    state.reason = undefined
    return { ok: true, docs: state.docs.length, built_at: state.built_at }
  }

  /** 只读健康状态；reason 是状态码，绝不包含记忆内容。 */
  async function health() {
    await ensureLoaded()
    const payload = {
      ok: state.indexed,
      backend: KEYWORD_BACKEND_NAME,
      docs: state.docs.length,
      built_at: state.built_at,
    }
    if (!state.indexed) payload.reason = state.reason ?? 'index_unavailable'
    return payload
  }

  /** 磁盘索引是否已成功加载或构建。 */
  async function isIndexed() {
    await ensureLoaded()
    return state.indexed
  }

  return {
    name: KEYWORD_BACKEND_NAME,
    add,
    remove,
    search,
    rebuild,
    health,
    isIndexed,
  }
}
