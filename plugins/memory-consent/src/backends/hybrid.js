/**
 * 混合检索后端（hybrid）：关键词 + 语义结果用 RRF（倒数排名融合）合并。
 *
 * 规则（docs/prompts/memory-module.md §6.1）：
 * - RRF 分数 = Σ 1/(k + rank + 1)，k 默认 60；rank 从 0 开始（列表顺序即排名）。
 * - 同一个 id 出现在多个列表里：分数相加；matched_by 取排名更靠前的那个列表，并列时取 'semantic'。
 * - 任一后端抛错/不可用 → 用另一个后端的结果，返回 degraded: true 并写 degraded_reason；
 *   两个都失败 → 抛稳定 code 'SEARCH_UNAVAILABLE'（message 只有 code，不携带查询原文）。
 * - 相对阈值：只保留 score >= best * minScoreRatio 且 score > 0 的结果。
 *
 * 索引是派生数据：add/remove/rebuild 的失败不向上抛（health() 会如实报告），
 * 只有 search 在「没有任何可用后端」时才抛错。
 */

export const HYBRID_BACKEND_NAME = 'hybrid'
export const RRF_K = 60
export const MIN_SCORE_RATIO = 0.35
export const SEARCH_UNAVAILABLE = 'SEARCH_UNAVAILABLE'

const BACKEND_KEYWORD = 'keyword'
const BACKEND_SEMANTIC = 'semantic'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 抛给上层的稳定错误：message 只含 code。 */
export function searchUnavailableError() {
  const error = new Error(SEARCH_UNAVAILABLE)
  error.code = SEARCH_UNAVAILABLE
  return error
}

/**
 * 倒数排名融合。
 *
 * @param {Array<{ backend: 'keyword'|'semantic', items: Array<{ id: string, score?: number }> }>} lists
 * @param {{ k?: number, limit?: number }} [options]
 * @returns {Array<{ id: string, score: number, matched_by: 'keyword'|'semantic' }>}
 */
export function reciprocalRankFusion(lists, { k = RRF_K, limit } = {}) {
  if (!Array.isArray(lists)) throw new TypeError('reciprocalRankFusion: lists 必须是数组')
  const resolvedK = Number.isFinite(k) && k >= 0 ? k : RRF_K
  /** @type {Map<string, { score: number, bestRank: number, matched_by: string }>} */
  const merged = new Map()
  for (const list of lists) {
    if (!isPlainObject(list) || !Array.isArray(list.items)) continue
    const backend = list.backend === BACKEND_SEMANTIC ? BACKEND_SEMANTIC : BACKEND_KEYWORD
    const seenInList = new Set()
    list.items.forEach((item, rank) => {
      if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '') return
      // 同一个列表里重复出现的 id 只按最好名次计一次，避免分数虚高。
      if (seenInList.has(item.id)) return
      seenInList.add(item.id)
      const contribution = 1 / (resolvedK + rank + 1)
      const current = merged.get(item.id)
      if (current === undefined) {
        merged.set(item.id, { score: contribution, bestRank: rank, matched_by: backend })
        return
      }
      current.score += contribution
      const betterRank = rank < current.bestRank
      const tiedButSemantic = rank === current.bestRank && backend === BACKEND_SEMANTIC
      if (betterRank || tiedButSemantic) {
        current.bestRank = rank
        current.matched_by = backend
      }
    })
  }
  let results = [...merged.entries()].map(([id, value]) => ({
    id,
    score: value.score,
    matched_by: value.matched_by,
  }))
  results.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  if (Number.isInteger(limit) && limit >= 0) results = results.slice(0, limit)
  return results
}

/** 把一个后端的原始命中列表包装成 RRF 输入。 */
function toFusionList(backend, items) {
  return { backend, items }
}

/**
 * 创建混合后端。
 *
 * @param {object} params
 * @param {object|null} params.keyword  关键词后端（createKeywordBackend 的返回值）
 * @param {object|null} [params.memsearch]  语义后端；未配置时为 null（此时等于纯关键词模式）
 * @param {number} [params.minScoreRatio]  相对阈值，默认 0.35
 */
export function createHybridBackend({ keyword = null, memsearch = null, minScoreRatio = MIN_SCORE_RATIO } = {}) {
  if (keyword === null && memsearch === null) {
    throw new TypeError('hybrid backend: keyword 与 memsearch 至少要提供一个')
  }
  const resolvedRatio =
    Number.isFinite(minScoreRatio) && minScoreRatio > 0 && minScoreRatio <= 1 ? minScoreRatio : MIN_SCORE_RATIO

  /** 调用一个后端并把它归类为「成功/失败」，不保留错误 message（避免内容泄漏到返回值）。 */
  async function callBackend(backend, query, options) {
    try {
      const value = await backend.search(query, options)
      if (!Array.isArray(value)) return { ok: false }
      return { ok: true, items: value }
    } catch {
      return { ok: false }
    }
  }

  /** 相对阈值 + 正分数 + limit。 */
  function finalize(fused, options) {
    const bestScore = fused.length > 0 ? fused[0].score : 0
    let results = fused.filter((item) => item.score > 0 && item.score >= bestScore * resolvedRatio)
    const limit = Number.isInteger(options?.limit) && options.limit >= 0 ? options.limit : null
    if (limit !== null) results = results.slice(0, limit)
    return results
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, signal?: AbortSignal, categories?: string[], since?: any, until?: any }} [options]
   * @returns {Promise<{ results: Array<object>, backend_used: 'hybrid'|'keyword'|'semantic', degraded: boolean, degraded_reason?: string }>}
   */
  async function search(query, options = {}) {
    if (typeof query !== 'string' || query === '') {
      return { results: [], backend_used: HYBRID_BACKEND_NAME, degraded: false }
    }
    if (options?.signal && options.signal.aborted) {
      const error = new Error('SEARCH_ABORTED')
      error.code = 'SEARCH_ABORTED'
      error.name = 'AbortError'
      throw error
    }
    const keywordAvailable = keyword !== null && typeof keyword?.search === 'function'
    const semanticAvailable = memsearch !== null && typeof memsearch?.search === 'function'

    // 两个后端并发跑；单个后端失败不拖累另一个。
    const [keywordOutcome, semanticOutcome] = await Promise.all([
      keywordAvailable ? callBackend(keyword, query, options) : Promise.resolve({ ok: false, skipped: true }),
      semanticAvailable ? callBackend(memsearch, query, options) : Promise.resolve({ ok: false, skipped: true }),
    ])

    if (keywordAvailable && semanticAvailable) {
      if (keywordOutcome.ok && semanticOutcome.ok) {
        const fused = reciprocalRankFusion([
          toFusionList(BACKEND_KEYWORD, keywordOutcome.items),
          toFusionList(BACKEND_SEMANTIC, semanticOutcome.items),
        ])
        return { results: finalize(fused, options), backend_used: HYBRID_BACKEND_NAME, degraded: false }
      }
      if (keywordOutcome.ok) {
        const fused = reciprocalRankFusion([toFusionList(BACKEND_KEYWORD, keywordOutcome.items)])
        return {
          results: finalize(fused, options),
          backend_used: BACKEND_KEYWORD,
          degraded: true,
          degraded_reason: 'semantic_failed',
        }
      }
      if (semanticOutcome.ok) {
        const fused = reciprocalRankFusion([toFusionList(BACKEND_SEMANTIC, semanticOutcome.items)])
        return {
          results: finalize(fused, options),
          backend_used: BACKEND_SEMANTIC,
          degraded: true,
          degraded_reason: 'keyword_failed',
        }
      }
      throw searchUnavailableError()
    }

    // 只配置了一个后端。
    const singleAvailable = keywordAvailable || semanticAvailable
    const singleOutcome = keywordAvailable ? keywordOutcome : semanticOutcome
    if (!singleAvailable || !singleOutcome.ok) throw searchUnavailableError()
    const backend = keywordAvailable ? BACKEND_KEYWORD : BACKEND_SEMANTIC
    const fused = reciprocalRankFusion([toFusionList(backend, singleOutcome.items)])
    return { results: finalize(fused, options), backend_used: backend, degraded: false }
  }

  /** 把操作分发到所有已配置的后端；索引是派生数据，单个后端失败不阻断另一个。 */
  async function runOnBackends(method, argument) {
    const targets = [keyword, memsearch].filter((backend) => backend !== null && typeof backend?.[method] === 'function')
    if (targets.length === 0) return { ok: false, failed: 0, total: 0 }
    const outcomes = await Promise.allSettled(targets.map((backend) => backend[method](argument)))
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length
    return { ok: failed === 0, failed, total: targets.length }
  }

  async function add(record) {
    return runOnBackends('add', record)
  }

  async function remove(id) {
    return runOnBackends('remove', id)
  }

  async function rebuild(records) {
    return runOnBackends('rebuild', records)
  }

  /** 关键词索引是否可用；没有关键词后端时视为可用（纯语义模式）。 */
  async function isIndexed() {
    if (keyword === null || typeof keyword.isIndexed !== 'function') return true
    try {
      return await keyword.isIndexed()
    } catch {
      return false
    }
  }

  /** 只读健康状态：两个后端的 health 结果都只含状态码，不含记忆内容。 */
  async function health() {
    const readHealth = async (backend) => {
      if (backend === null || typeof backend?.health !== 'function') return null
      try {
        return await backend.health()
      } catch {
        return { ok: false, backend: 'unknown', reason: 'health_failed' }
      }
    }
    const [keywordHealth, semanticHealth] = await Promise.all([readHealth(keyword), readHealth(memsearch)])
    const keywordOk = keyword === null ? true : keywordHealth?.ok === true
    const semanticOk = memsearch === null ? true : semanticHealth?.ok === true
    const ok = keywordOk && semanticOk
    const payload = {
      ok,
      backend: HYBRID_BACKEND_NAME,
      backends: { keyword: keywordHealth, memsearch: semanticHealth },
      degraded: memsearch !== null && !semanticOk,
    }
    if (!ok) payload.reason = 'backend_unavailable'
    return payload
  }

  return {
    name: HYBRID_BACKEND_NAME,
    add,
    remove,
    search,
    rebuild,
    health,
    isIndexed,
  }
}
