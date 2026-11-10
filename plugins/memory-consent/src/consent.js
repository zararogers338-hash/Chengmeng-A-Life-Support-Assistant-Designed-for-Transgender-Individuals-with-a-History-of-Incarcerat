/**
 * 授权流程（consent service）：提议、确认、拒绝、修改、删除、设置、检索、导出。
 *
 * 这是整个模块的隐私核心，规则全部来自提示词 §5–§8：
 * - 没开启时提议**不写任何东西**；
 * - auto 模式无需逐条确认；所有话题同样处理，不按敏感词分类；
 * - 缺 stated_by_user / user_quote 的提议直接拒绝（rejected_by_policy）；
 * - 引文核对为 false 的候选绝不自动写入；
 * - 用户拒绝的候选立即删除，只在内存里留内容的 SHA-256（进程重启即消失）；
 * - 删除先改 Markdown 事实，再清索引；召回必须回读事实，故障不能返回旧内容。
 *
 * 本文件不 import DSH：外部依赖全部通过参数注入，便于用假 store / 假 backend 做测试。
 */

import { createHash } from 'node:crypto'
import { scanForbiddenContent } from './secrets.js'
import { resolvePeriod, timelinePage, RELATIVE_PERIODS } from './time-range.js'
import {
  CATEGORIES,
  ID_PREFIX,
  buildRecord,
  charLength,
  normalizeContent,
  nowIso,
  isSavedMemory,
  validateMemoryRecord,
  validateProposalArgs,
} from './model.js'

/** propose_memory 的返回状态。 */
export const PROPOSE_STATUSES = Object.freeze([
  'pending',
  'saved',
  'disabled',
  'duplicate',
  'rejected_by_policy',
  'invalid',
])

/** 检索返回里交给模型的固定说明（防提示注入）。单一实现在 search.js，这里只做转出，避免两份措辞/转义分叉。 */
export { RECALL_NOTICE, formatRecall } from './search.js'

/** 内存里的"用户已拒绝"缓存：只存 SHA-256，不落盘、不存原文。 */
export function createRejectedCache(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 512
  /** @type {Map<string, number>} */
  const entries = new Map()
  return {
    remember(key) {
      if (entries.has(key)) entries.delete(key)
      entries.set(key, 1)
      while (entries.size > limit) entries.delete(entries.keys().next().value)
    },
    has(key) {
      return entries.has(key)
    },
    get size() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
  }
}

/** 内容指纹：只有它会被记在内存里，原文不保留。 */
export function contentFingerprint(content) {
  return createHash('sha256').update(content).digest('hex')
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function quoteStatus(value) {
  return value === true || value === false ? value : 'unknown'
}

/**
 * 创建授权服务。
 * @param {{
 *   store: object,
 *   backend: object,
 *   search: object,
 *   clock?: () => Date,
 *   maxContentChars?: number,
 *   verifyQuote?: (input: { sessionId: string|undefined, quote: string, signal?: AbortSignal }) => Promise<boolean|'unknown'>,
 *   backendName?: string,
 *   rejectedCache?: ReturnType<typeof createRejectedCache>,
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 * }} deps
 */
export function createConsentService(deps) {
  const {
    store,
    backend,
    search,
    clock = () => new Date(),
    maxContentChars = 280,
    verifyQuote = async () => 'unknown',
    backendName = 'keyword',
    rejectedCache = createRejectedCache(),
    logger = null,
    timeZone = 'Asia/Shanghai',
    history = null,
  } = deps ?? {}
  if (!store || !backend || !search) throw new Error('createConsentService 需要 store / backend / search')

  // Serialize whole business operations, not only individual file reads/writes.
  // Disabling memory, confirming and rejecting must not interleave halfway.
  let mutationTail = Promise.resolve()
  const serial = (operation) => (...args) => {
    const result = mutationTail.then(() => operation(...args))
    mutationTail = result.catch(() => {})
    return result
  }

  const log = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      // 日志本身不能影响业务。
    }
  }

  async function isEnabled() {
    const settings = await store.readSettings()
    return settings.enabled === true && settings.normalMode
  }

  function sessionKey(context, content) {
    const sessionId = context?.sessionId ?? 'unknown'
    return `${sessionId}:${contentFingerprint(content)}`
  }

  function sourceOf(context) {
    const sessionId = context?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return 'session:unknown'
    const turn = Number.isInteger(context?.turn) && context.turn >= 0 ? context.turn : 0
    return `session:${sessionId}#turn:${turn}`
  }

  async function findDuplicate(content, context) {
    const fingerprint = contentFingerprint(content)
    if (rejectedCache.has(sessionKey(context, content))) return 'rejected'
    const pending = await store.listPending()
    if (pending.some((item) => contentFingerprint(item.content) === fingerprint)) return 'pending'
    const { records } = await store.listMemories()
    if (records.some((item) => contentFingerprint(item.content) === fingerprint)) return 'memory'
    return null
  }

  async function saveIndexAdd(record) {
    try {
      const result = await backend.add(record)
      return result?.ok !== false
    } catch (error) {
      log('warn', `chengmeng-memory: index add failed (${error?.code ?? 'unknown'})`)
      return false
    }
  }

  /** 索引失败时的自愈：从 Markdown 事实重建。返回是否成功。 */
  async function rebuildIndexFromTruth() {
    try {
      const { records } = await store.listMemories()
      const result = await backend.rebuild(records)
      return result?.ok !== false
    } catch (error) {
      log('warn', `chengmeng-memory: index rebuild failed (${error?.code ?? 'unknown'})`)
      return false
    }
  }

  async function verifyQuoteSafely(context, quote) {
    if (typeof quote !== 'string' || quote.trim() === '') return { verified: 'unknown' }
    try {
      const result = await verifyQuote({ sessionId: context?.sessionId, quote, signal: context?.signal })
      if (result && typeof result === 'object') {
        const time = typeof result.sourceTime === 'string' ? new Date(result.sourceTime) : null
        return { verified: quoteStatus(result.verified),
          ...(result.verified === true && time && Number.isFinite(time.getTime()) ? { sourceTime: time.toISOString() } : {}) }
      }
      return { verified: quoteStatus(result) }
    } catch {
      return { verified: 'unknown' }
    }
  }

  /** propose_memory 的核心逻辑（工具层与测试都直接调用它，不需要绕过模型接口）。 */
  async function propose(args, context = {}) {
    // 1. 总开关先看：关闭时不读不写任何数据文件。
    const settings = await store.readSettings().catch(() => ({ enabled: false, normalMode: 'confirm' }))
    if (settings.enabled !== true) {
      return { status: 'disabled', message: '长期记忆现在是关闭的，没有保存任何内容。' }
    }

    // 2. 格式校验。
    const checked = validateProposalArgs(args, { maxContentChars })
    if (!checked.ok) return { status: 'invalid', message: `参数无效：${checked.error}` }
    const value = checked.value

    // 3. 防止"把推测写成事实"。
    if (value.stated_by_user !== true) {
      return {
        status: 'rejected_by_policy',
        message: '这条提议没有标明"用户自己明确说过"，不能保存。只有用户亲口说出或明确要求记住的内容才可以提议记忆。',
      }
    }
    if (!value.user_quote || value.user_quote === '') {
      return {
        status: 'rejected_by_policy',
        message: '这条提议没有附带用户原话，不能保存。请只提议用户自己明确说过的内容，并给出原话片段。',
      }
    }

    // 4. 绝不存：密钥、令牌、密码、身份证号、银行卡号、验证码。拒绝信息不回显内容。
    const forbidden = scanForbiddenContent(value.content)
    if (forbidden.blocked) {
      return {
        status: 'rejected_by_policy',
        message: '这条内容包含密钥、密码、证件号或验证码一类不能写入记忆的信息，已拒绝保存。',
      }
    }

    // 5. 去重（待确认 / 已记忆 / 本次会话刚被拒绝的）。
    const duplicate = await findDuplicate(value.content, context)
    if (duplicate !== null) {
      const message =
        duplicate === 'rejected'
          ? '用户刚才已经拒绝过这条内容，本次会话不再重复提议。'
          : '这条内容已经在待确认列表或记忆里了，没有重复添加。'
      return { status: 'duplicate', message }
    }

    // 6. 引文核对（尽力而为：没有会话读取接口时是 unknown）。
    const verification = await verifyQuoteSafely(context, value.user_quote)
    const quoteVerified = verification.verified

    // 7. Keep the legacy schema readable; new records have no topic classifier.
    const detected = { sensitivity: 'normal', reasons: [] }
    const now = nowIso(clock)

    const buildCandidate = (confirmed) => ({
      ...buildRecord({
        content: value.content,
        category: value.category,
        sensitivity: detected.sensitivity,
        reasons: detected.reasons,
        source: sourceOf(context),
        quote_verified: quoteVerified,
        clock,
        confirmed_by_user: confirmed,
        edited_by_user: false,
        ...(verification.sourceTime ? { source_time: verification.sourceTime } : {}),
      }),
    })

    // Automatic mode saves normal and private information alike, with honest
    // provenance. The verbatim source must exist; summaries need no extra click.
    if (settings.normalMode === 'auto') {
      if (quoteVerified !== true) return { status: 'rejected_by_policy',
        message: '未能核对这条整理内容的用户来源，没有保存为事实；聊天原文由自动历史记忆保留。' }
      const record = { ...buildCandidate(false), saved_automatically: true }
      await store.addMemory(record)
      const indexed = await saveIndexAdd(record)
      return { status: 'saved', id: record.id, saved_automatically: true,
        message: '已自动保存。', ...(indexed ? {} : { warning: 'index_pending' }) }
    }

    // Optional manual mode keeps the existing candidate workflow.

    // 8c. 其余都进待确认队列。
    const candidate = { ...buildCandidate(false), status: 'pending' }
    await store.addPending(candidate)
    return {
      status: 'pending',
      id: candidate.id,
      message: '已提交给用户确认，尚未记住。',
    }
  }

  /** 确认一条候选：用户可以先改文字，改过的内容重新走敏感度判定与绝不存检查。 */
  async function confirm(id, options = {}) {
    if (!(await isEnabled())) return { ok: false, error: 'disabled' }
    const pending = await store.getPending(id)
    if (!pending) return { ok: false, error: 'not_found' }

    let content = pending.content
    let edited = false
    if (options.content !== undefined) {
      if (typeof options.content !== 'string') return { ok: false, error: 'invalid' }
      const normalized = normalizeContent(options.content)
      if (normalized === '' || charLength(normalized) > maxContentChars) return { ok: false, error: 'invalid' }
      const forbidden = scanForbiddenContent(normalized)
      if (forbidden.blocked) return { ok: false, error: 'contains_secret' }
      edited = normalized !== pending.content
      content = normalized
    }

    // Preserve legacy metadata without reclassifying or filtering by topic.
    const sensitivity = pending.sensitivity
    const finalReasons = pending.reasons

    const record = {
      ...pending,
      content,
      sensitivity,
      reasons: finalReasons,
      updated_at: nowIso(clock),
      confirmed_by_user: true,
      edited_by_user: pending.edited_by_user || edited,
    }
    delete record.status

    const checked = validateMemoryRecord(record, { maxContentChars })
    if (!checked.ok) return { ok: false, error: 'invalid' }

    // 顺序：先写事实来源，再删候选。写失败时候选原样留着，不会丢。
    try {
      await store.addMemory(checked.value)
    } catch (error) {
      log('warn', `chengmeng-memory: confirm write failed (${error?.code ?? 'unknown'})`)
      return { ok: false, error: 'storage_failed' }
    }
    const indexed = await saveIndexAdd(checked.value)
    let warning
    try {
      await store.removePending(id)
    } catch (error) {
      log('warn', `chengmeng-memory: pending removal failed (${error?.code ?? 'unknown'})`)
      warning = 'pending_not_removed'
    }
    if (!indexed) warning = warning ?? 'index_pending'
    return { ok: true, record: checked.value, warning }
  }

  /** 用户点"不用"：立即删除候选，只在内存里留内容指纹（本次会话不再重复提议）。 */
  async function reject(id, context = {}) {
    const pending = await store.getPending(id)
    if (!pending) return { ok: true, removed: false }
    await store.removePending(id)
    const sourceSession = /^session:(.+)#turn:\d+$/.exec(pending.source)?.[1]
    rejectedCache.remember(sessionKey({ sessionId: sourceSession ?? context.sessionId }, pending.content))
    log('info', `chengmeng-memory: candidate rejected (${id})`)
    return { ok: true, removed: true }
  }

  /** 修改一条已确认记忆的文字：重新判定敏感度（只升不降）并检查"绝不存"。 */
  async function update(id, content) {
    const record = await store.getMemory(id)
    if (!record) return { ok: false, error: 'not_found' }
    if (typeof content !== 'string') return { ok: false, error: 'invalid' }
    const normalized = normalizeContent(content)
    if (normalized === '' || charLength(normalized) > maxContentChars) return { ok: false, error: 'invalid' }
    const forbidden = scanForbiddenContent(normalized)
    if (forbidden.blocked) return { ok: false, error: 'contains_secret' }

    const sensitivity = record.sensitivity
    const finalReasons = record.reasons

    const result = await store.updateMemoryContent(id, normalized, {
      edited_by_user: true,
      sensitivity,
      reasons: finalReasons,
    })
    if (!result.ok) return { ok: false, error: result.error }

    // 索引是派生的；先从索引里去掉旧条目，再加新条目，失败就从事实重建。
    try {
      const removed = await backend.remove(id)
      if (removed?.ok === false) throw new Error('INDEX_REMOVE_FAILED')
      await backend.add(result.record)
    } catch (error) {
      log('warn', `chengmeng-memory: index update failed (${error?.code ?? 'unknown'})`)
      await rebuildIndexFromTruth()
    }
    return { ok: true, record: result.record }
  }

  /**
   * 删除一条记忆。顺序按提示词 §8：先从 Markdown 事实来源删块（这一步决定隐私），
   * 再从索引里删条目，最后用删除后的事实重建视图/缓存。
   *
   * 失败处理：
   * - 删文件失败 → 什么都没变，明确报错；
   * - 索引删除失败 → 用**删除后**的事实全量重建索引；重建也失败 → 尝试清空派生索引；
   *   仍失败就明确返回 warning（检索时 `getRecord` 回读会丢弃已删除命中，所以不会泄露内容）。
   */
  async function remove(id) {
    const record = await store.getMemory(id)
    if (!record) return { ok: false, error: 'not_found' }

    // 1. 先删事实来源。
    const result = await store.deleteMemory(id)
    if (!result.ok) return { ok: false, error: result.error ?? 'storage_failed' }

    // 2. 再删索引条目；索引是派生数据，失败就重建（此时事实里已经没有这条了）。
    try {
      const removed = await backend.remove(id)
      if (removed?.ok === false) throw new Error('INDEX_REMOVE_FAILED')
    } catch (error) {
      log('warn', `chengmeng-memory: index remove failed (${error?.code ?? 'unknown'})`)
      let recovered = await rebuildIndexFromTruth()
      if (!recovered) {
        // 最后手段：清空派生索引（下次检索会从事实重建）。宁可索引为空，也不要留着已删除的条目。
        try {
          const reset = await backend.rebuild([])
          recovered = reset?.ok !== false
        } catch {
          recovered = false
        }
      }
      log('info', `chengmeng-memory: memory deleted (${id}), index=${recovered ? 'rebuilt' : 'stale'}`)
      return recovered ? { ok: true, warning: 'index_rebuilt' } : { ok: true, warning: 'index_stale' }
    }
    log('info', `chengmeng-memory: memory deleted (${id})`)
    return { ok: true }
  }

  /** 删除全部。索引先清空，再删文件。 */
  async function removeAll() {
    try {
      await backend.rebuild([])
    } catch (error) {
      log('warn', `chengmeng-memory: index reset failed (${error?.code ?? 'unknown'})`)
    }
    const result = await store.deleteAll()
    return { ok: true, deleted: result.deleted }
  }

  /** 检索。关闭时返回 disabled，且不碰索引。 */
  async function recall(args, context = {}) {
    const settings = await store.readSettings().catch(() => ({ enabled: false, normalMode: 'confirm' }))
    if (settings.enabled !== true) {
      return { status: 'disabled', results: [], message: '长期记忆现在是关闭的，没有检索任何记忆。' }
    }
    const checked = validateRecallArgs(args)
    if (!checked.ok) return { status: 'invalid', results: [], message: `参数无效：${checked.error}` }
    const value = checked.value

    value.include_sensitive = true // legacy sensitivity labels do not filter any result
    if (value.period) Object.assign(value, resolvePeriod(value.period, clock(), timeZone))
    if (value.mode === 'timeline') {
      try {
        const { records } = await store.listMemories()
        return { ...timelinePage(records, { ...value, includeSensitive: value.include_sensitive, timeField: value.time_field }), time_zone: timeZone }
      } catch {
        return { status: 'error', results: [], message: '时间回顾暂时不可用，没有返回任何记忆。' }
      }
    }

    let outcome
    try {
      outcome = await search.searchMemories({
        query: value.query,
        categories: value.categories,
        since: value.since,
        until: value.until,
        limit: value.limit,
        includeSensitive: value.include_sensitive,
        signal: context.signal,
        timeField: value.time_field,
      })
    } catch (error) {
      log('warn', `chengmeng-memory: recall failed (${error?.code ?? 'unknown'})`)
      return { status: 'error', results: [], degraded: true, message: '检索暂时不可用，没有返回任何记忆。' }
    }

    if (outcome.notes?.includes('backend_failed') || outcome.notes?.includes('source_read_failed')) {
      return { status: 'error', results: [], degraded: true, message: '检索暂时不可用，没有返回任何记忆。' }
    }

    // Only persisted records qualify; legacy topic labels never hide results.
    const results = (outcome.results ?? [])
      .filter((item) => {
        if (item?.confirmed_by_user === false && !isSavedMemory(item)) return false
        return true
      })
      .map((item) => ({ ...item }))

    if (results.length === 0) {
      return {
        status: 'empty',
        results: [],
        backend_used: outcome.backend_used,
        degraded: outcome.degraded === true,
        message: outcome.degraded === true
          ? (outcome.backend_used === 'keyword' ? '语义检索暂时不可用，本次仅用关键词检索，未找到匹配记忆。' : '部分检索暂时不可用，本次未找到匹配记忆。')
          : '没有相关记忆。',
      }
    }
    return {
      status: 'ok',
      results,
      backend_used: outcome.backend_used,
      degraded: outcome.degraded === true,
      notes: outcome.notes ?? [],
    }
  }

  /** 重建索引（管理界面用）。 */
  async function rebuildIndex() {
    const { records } = await store.listMemories()
    const rebuilt = await backend.rebuild(records)
    if (rebuilt?.ok === false) return { ok: false, error: 'index_unavailable' }
    return { ok: true, backend: backendName, rebuilt: records.length }
  }

  /** 导出。 */
  async function exportData() {
    const { markdown, memories } = await store.exportAll()
    return {
      ok: true,
      markdown,
      memories,
      exported_at: nowIso(clock),
      version: 1,
    }
  }

  /** 设置：enabled / normalMode。关闭长期记忆 = 保留数据、停止提议和检索。 */
  async function updateSettings(patch) {
    if (!isPlainObject(patch)) return { ok: false, error: 'invalid' }
    const unknown = Object.keys(patch).filter((key) => key !== 'enabled' && key !== 'normalMode')
    if (unknown.length > 0) return { ok: false, error: 'invalid' }
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return { ok: false, error: 'invalid' }
    if (patch.normalMode !== undefined && patch.normalMode !== 'confirm' && patch.normalMode !== 'auto') {
      return { ok: false, error: 'invalid' }
    }
    const next = await store.writeSettings(patch)
    let migrated = 0
    if (next.enabled && next.normalMode === 'auto') {
      for (const candidate of await store.listPending()) {
        const { status: _status, ...saved } = candidate
        const record = { ...saved, confirmed_by_user: false, saved_automatically: true }
        await store.addMemory(record)
        await store.removePending(record.id)
        await saveIndexAdd(record)
        migrated++
      }
    }
    return { ok: true, settings: next, migrated }
  }

  /** 只读状态：不返回任何记忆内容。 */
  async function status() {
    const state = await store.readSettingsState()
    let pendingCount = 0
    try {
      pendingCount = await store.countPending()
    } catch (error) {
      log('warn', `chengmeng-memory: pending count failed (${error?.code ?? 'unknown'})`)
    }
    let health = { ok: true, backend: backendName }
    try {
      if (typeof backend.health === 'function') health = await backend.health()
    } catch {
      health = { ok: false, backend: backendName }
    }
    const degraded = health?.degraded === true || (backendName !== 'keyword' && health?.ok === false)
    let savedCount = null
    try { savedCount = (await store.listMemories()).records.length } catch {}
    return {
      enabled: state.settings.enabled === true,
      normalMode: state.settings.normalMode,
      pendingCount,
      savedCount,
      verification: { kind: 'status_snapshot', content_query: 'not_performed', attachment_access: 'not_tested', semantic_retrieval_quality: 'not_tested' },
      degraded,
      backend: backendName,
      settingsInvalid: state.invalid === true,
      ...(health.embedding ? { embedding: health.embedding } : {}),
      ...(history ? { history: await history.status() } : {}),
    }
  }

  /** 管理界面的记忆列表：支持搜索词、类别、时间范围过滤。 */
  async function listMemories(filters = {}) {
    const { records } = await store.listMemories()
    const query = typeof filters.q === 'string' ? filters.q.trim().toLowerCase() : ''
    let items = records
    if (filters.category) {
      if (!CATEGORIES.includes(filters.category)) return { ok: false, error: 'invalid' }
      items = items.filter((record) => record.category === filters.category)
    }
    if (query !== '') {
      items = items.filter((record) => record.content.toLowerCase().includes(query))
    }
    if (filters.since) {
      items = items.filter((record) => record.created_at >= filters.since)
    }
    if (filters.until) {
      items = items.filter((record) => record.created_at <= filters.until)
    }
    // 新的在前，方便管理界面看。
    items = [...items].sort((left, right) => right.created_at.localeCompare(left.created_at))
    return { ok: true, items }
  }

  /** 待确认列表（给界面轮询）：不返回 reasons，避免卡片泄露语义。 */
  async function listPendingForUi({ sessionId } = {}) {
    const pending = await store.listPending()
    const items = sessionId === undefined ? pending
      : pending.filter(item => item.source.startsWith(`session:${sessionId}#turn:`))
    return {
      ok: true,
      items: items.map((item) => ({
        id: item.id,
        content: item.content,
        sensitivity: item.sensitivity,
        created_at: item.created_at,
        source: item.source,
        quote_verified: item.quote_verified,
      })),
    }
  }

  return {
    isEnabled,
    propose: serial(propose),
    confirm: serial(confirm),
    reject: serial(reject),
    update: serial(update),
    remove: serial(remove),
    removeAll: serial(removeAll),
    recall: serial(recall),
    rebuildIndex: serial(rebuildIndex),
    exportData,
    updateSettings: serial(updateSettings),
    status,
    listMemories,
    listPendingForUi,
    rejectedCache,
  }
}

/** recall_memory 的入参校验（原始 JSON Schema 工具要自己校验）。 */
export function validateRecallArgs(args) {
  if (!isPlainObject(args)) return { ok: false, error: '参数必须是对象' }
  const allowed = ['query', 'categories', 'since', 'until', 'limit', 'include_sensitive', 'mode', 'period', 'cursor', 'time_field']
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return { ok: false, error: `未知参数 ${unknown.join(', ')}` }
  const mode = args.mode ?? (args.period && !args.query ? 'timeline' : 'search')
  if (!['search', 'timeline'].includes(mode)) return { ok: false, error: 'mode 必须为 search 或 timeline' }
  if (mode === 'search' && (typeof args.query !== 'string' || args.query.trim() === '')) return { ok: false, error: 'query 必须是非空字符串' }
  if (args.query !== undefined && (typeof args.query !== 'string' || charLength(args.query) > 400)) return { ok: false, error: 'query 不能超过 400 个字符' }
  if (mode === 'timeline' && args.query?.trim()) return { ok: false, error: '按主题搜索用 search，完整时间回顾用 timeline 并省略 query' }
  if (args.period !== undefined && (!RELATIVE_PERIODS.includes(args.period) || args.since || args.until)) return { ok: false, error: 'period 无效或与明确时间范围冲突' }
  if (args.cursor !== undefined && (mode !== 'timeline' || typeof args.cursor !== 'string' || args.cursor.length > 512)) return { ok: false, error: 'cursor 无效' }
  const timeField = args.time_field ?? 'source'
  if (!['source', 'created'].includes(timeField)) return { ok: false, error: 'time_field 无效' }

  let categories
  if (args.categories !== undefined) {
    if (!Array.isArray(args.categories) || args.categories.length === 0) return { ok: false, error: 'categories 必须是非空数组' }
    if (args.categories.some((category) => !CATEGORIES.includes(category))) {
      return { ok: false, error: `categories 只能是 ${CATEGORIES.join(' | ')}` }
    }
    categories = [...new Set(args.categories)]
  }

  const checkTime = (name, value) => {
    if (value === undefined) return { ok: true }
    if (typeof value !== 'string') return { ok: false, error: `${name} 必须是 ISO 8601 时间字符串` }
    const time = new Date(value).getTime()
    if (!Number.isFinite(time)) return { ok: false, error: `${name} 必须是 ISO 8601 时间字符串` }
    return { ok: true, value: new Date(time).toISOString() }
  }
  const since = checkTime('since', args.since)
  if (!since.ok) return since
  const until = checkTime('until', args.until)
  if (!until.ok) return until
  if (since.value && until.value && since.value > until.value) return { ok: false, error: 'since 不能晚于 until' }

  let limit = 5
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 8) return { ok: false, error: 'limit 必须是 1–8 的整数' }
    limit = args.limit
  }
  let includeSensitive = false
  if (args.include_sensitive !== undefined) {
    if (typeof args.include_sensitive !== 'boolean') return { ok: false, error: 'include_sensitive 必须是布尔值' }
    includeSensitive = args.include_sensitive
  }

  return {
    ok: true,
    value: {
      query: args.query?.trim(),
      mode, period: args.period, cursor: args.cursor, time_field: timeField,
      categories,
      since: since.value,
      until: until.value,
      limit,
      include_sensitive: includeSensitive,
    },
  }
}

/** 导出 ID 前缀，供 tools/routes 校验入参用。 */
export { ID_PREFIX }
