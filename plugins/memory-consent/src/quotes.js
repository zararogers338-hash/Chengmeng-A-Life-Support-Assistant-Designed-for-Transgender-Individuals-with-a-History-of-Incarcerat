/**
 * 引文核对：尽力确认 `user_quote` 真的出现在该会话的用户消息里。
 *
 * 核实结论（ADR-002，读 DSH 0.2.2-rc.1 的 `dsh-session-query` 源码）：
 * - 官方服务 `ctx.sessionQuery.filterEvents(sessionId, filters)` 支持
 *   `{ kind: 'text', text }` 过滤器：对提取出的语义文本做"字面、不区分大小写、空白灵活"的扫描；
 *   `user/message` 事件的语义文本就是用户消息的文本块。
 * - 拿不到 `ctx.sessionQuery`（没装会话查询后端）或读取出错时返回 `'unknown'`，
 *   绝不假装核对过。
 *
 * 本文件不 import DSH：服务获取用注入的回调。
 */

/** `user/message` 是会话日志里用户消息的事件类型（源码：session-query 的 extractSessionEventText）。 */
export const USER_MESSAGE_EVENT = 'user/message'

/** 引文最长 120 字（提示词 §5.3）；这里只防御异常输入。 */
export const MAX_QUOTE_CHARS = 120

function normalizeQuote(quote) {
  return String(quote).replace(/\r\n?/g, '\n').trim()
}

/**
 * 创建引文核对器。
 * @param {{ getSessionQuery?: () => object | undefined }} deps
 * @returns {(input: { sessionId?: string, quote?: string, signal?: AbortSignal }) => Promise<boolean | 'unknown'>}
 */
export function createQuoteVerifier(deps = {}) {
  const getSessionQuery = deps.getSessionQuery ?? (() => undefined)

  return async function verifyQuote(input = {}) {
    const sessionId = input.sessionId
    const quote = typeof input.quote === 'string' ? normalizeQuote(input.quote) : ''
    if (typeof sessionId !== 'string' || sessionId === '' || quote === '') return 'unknown'
    if (input.signal?.aborted) return 'unknown'

    let service
    try {
      service = getSessionQuery()
    } catch {
      return 'unknown'
    }
    if (!service || typeof service.filterEvents !== 'function') return 'unknown'

    try {
      const hits = await service.filterEvents(sessionId, [
        { kind: 'type', values: [USER_MESSAGE_EVENT] },
        { kind: 'text', text: quote },
      ])
      if (!Array.isArray(hits)) return 'unknown'
      if (deps.includeSourceTime) {
        const last = [...hits].sort((a, b) => Number(b.seq) - Number(a.seq))[0]
        const time = last && typeof last.time === 'number' ? new Date(last.time) : null
        return { verified: hits.length > 0,
          ...(time && Number.isFinite(time.getTime()) ? { sourceTime: time.toISOString() } : {}) }
      }
      return hits.length > 0
    } catch {
      // 会话读不到（已结束、持久化后端不可用、被截断）时不能断言"用户没说过"。
      return 'unknown'
    }
  }
}
