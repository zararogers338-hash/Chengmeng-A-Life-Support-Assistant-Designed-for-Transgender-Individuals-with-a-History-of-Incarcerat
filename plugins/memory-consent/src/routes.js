/**
 * HTTP 路由（浏览器 ↔ Host）。前缀 /chengmeng-memory。
 *
 * 安全规则（docs/DEV_STANDARDS.md 第 8 节，全部是硬性要求）：
 * - **每个处理器的第一件事**是 `connection.requestRejection(req)`；被拒绝时直接返回，
 *   不读请求体、不执行任何业务。DSH 不会替插件自己的路由做认证。
 * - GET 只读，所有改数据的操作一律 POST；请求体必须是 application/json，有体积上限。
 * - 响应带 Cache-Control: no-store 与 X-Content-Type-Options: nosniff。
 * - 敏感内容不进 URL；错误响应不回显用户输入、不带堆栈与路径。
 * - 不另开监听端口。
 */

export const ROUTE_PREFIX = '/chengmeng-memory'

/** 普通请求体上限。 */
export const MAX_BODY_BYTES = 16 * 1024

const MAX_ID_CHARS = 80
const MAX_QUERY_CHARS = 200

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

function sendDownload(res, status, contentType, filename, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return { error: 413 }
    chunks.push(chunk)
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }
  } catch {
    return { error: 400 }
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: true, value: undefined }
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return { ok: false }
  return { ok: true, value: new Date(time).toISOString() }
}

/** 把业务错误码映射成 HTTP 状态；错误信息本身绝不包含用户内容。 */
function statusForError(code) {
  switch (code) {
    case 'invalid':
      return 400
    case 'not_found':
      return 404
    case 'disabled':
      return 409
    case 'contains_secret':
      return 400
    case 'storage_failed':
    case 'index_unavailable':
      return 500
    default:
      return 500
  }
}

function fail(res, error) {
  return sendJson(res, statusForError(error), { ok: false, error })
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS
}

/**
 * 创建路由处理器。
 * @param {{
 *   connection: { requestRejection: (req: object) => number | undefined },
 *   consent: object,
 *   logger?: { warn?: (message: string) => void },
 * }} deps
 */
export function createRouteHandler(deps) {
  const { connection, consent, history = null, logger = null, routePrefix = ROUTE_PREFIX } = deps ?? {}
  const log = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // 日志失败不影响响应。
    }
  }

  return async function handler(req, res) {
    // 认证：第一件事。被拒绝时不碰请求体、不碰业务。
    let rejection
    try {
      if (!connection || typeof connection.requestRejection !== 'function') {
        return sendJson(res, 500, { ok: false, error: 'internal_error' })
      }
      rejection = connection.requestRejection(req)
    } catch {
      return sendJson(res, 500, { ok: false, error: 'internal_error' })
    }
    if (rejection !== undefined) {
      return sendJson(res, rejection === 401 ? 401 : 403, {
        ok: false,
        error: rejection === 401 ? 'unauthorized' : 'forbidden',
      })
    }

    try {
      const url = new URL(req.url ?? '/', 'http://chengmeng.invalid')
      const path = url.pathname
      if (!path.startsWith(routePrefix)) return sendJson(res, 404, { ok: false, error: 'not_found' })
      const route = path.slice(routePrefix.length)

      if (req.method === 'GET') {
        if (route === '/status') return sendJson(res, 200, { ok: true, ...(await consent.status()) })

        if (route === '/pending') {
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          if (sessionId !== undefined && (!sessionId || sessionId.length > 200)) return fail(res, 'invalid')
          const result = await consent.listPendingForUi({ sessionId })
          return sendJson(res, 200, result)
        }

        if (route === '/memories') {
          // Free-text searches belong in a POST body, never a URL or access log.
          if (url.searchParams.has('q')) return fail(res, 'invalid')
          const category = url.searchParams.get('category') ?? undefined
          const q = url.searchParams.get('q') ?? undefined
          const since = parseIso(url.searchParams.get('since') ?? undefined)
          const until = parseIso(url.searchParams.get('until') ?? undefined)
          if (!since.ok || !until.ok) return sendJson(res, 400, { ok: false, error: 'invalid' })
          if (q !== undefined && q.length > MAX_QUERY_CHARS) return sendJson(res, 400, { ok: false, error: 'invalid' })
          const result = await consent.listMemories({
            category: category === '' ? undefined : category,
            q,
            since: since.value,
            until: until.value,
          })
          if (!result.ok) return fail(res, result.error)
          return sendJson(res, 200, result)
        }

        if (route === '/export') {
          const format = url.searchParams.get('format')
          if (format !== null && format !== 'md' && format !== 'json') {
            return sendJson(res, 400, { ok: false, error: 'invalid' })
          }
          const data = await consent.exportData()
          if (format === 'md') {
            return sendDownload(res, 200, 'text/markdown; charset=utf-8', 'chengmeng-memory-export.md', data.markdown)
          }
          if (format === 'json') {
            const payload = JSON.stringify({ version: data.version, exported_at: data.exported_at, memories: data.memories }, null, 2)
            return sendDownload(res, 200, 'application/json; charset=utf-8', 'chengmeng-memory-export.json', payload)
          }
          // 不带 format：一次给出两份（Markdown 原文 + 结构化数据），仍然是附件，仍然要认证。
          return sendDownload(
            res,
            200,
            'application/json; charset=utf-8',
            'chengmeng-memory-export.json',
            JSON.stringify({ ok: true, version: data.version, exported_at: data.exported_at, markdown: data.markdown, memories: data.memories }, null, 2),
          )
        }

        return sendJson(res, 404, { ok: false, error: 'not_found' })
      }

      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' })

      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'unsupported_media_type' })
      const body = await readJsonBody(req, MAX_BODY_BYTES)
      if (body.error) return sendJson(res, body.error, { ok: false, error: body.error === 413 ? 'too_large' : 'bad_json' })
      if (!isPlainObject(body.value)) return sendJson(res, 400, { ok: false, error: 'invalid' })
      const input = body.value

      if (route === '/history-query') {
        if (!history) return fail(res, 'not_found')
        return sendJson(res, 200, { ok: true, ...await history.recall(input) })
      }
      if (route === '/memory-query') {
        return sendJson(res, 200, { ok: true, ...await consent.recall(input) })
      }

      if (route === '/history-settings') {
        if (!history) return fail(res, 'not_found')
        if (Object.keys(input).some(key => key !== 'enabled') || typeof input.enabled !== 'boolean') return fail(res, 'invalid')
        return sendJson(res, 200, await history.setEnabled(input.enabled))
      }

      if (route === '/memories/search') {
        if (Object.keys(input).some(key => !['q', 'category', 'since', 'until'].includes(key))) return fail(res, 'invalid')
        if (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > MAX_QUERY_CHARS)) return fail(res, 'invalid')
        if (input.category !== undefined && typeof input.category !== 'string') return fail(res, 'invalid')
        if (['since', 'until'].some(key => input[key] !== undefined && typeof input[key] !== 'string')) return fail(res, 'invalid')
        const since = parseIso(input.since), until = parseIso(input.until)
        if (!since.ok || !until.ok || (since.value && until.value && since.value > until.value)) return fail(res, 'invalid')
        const result = await consent.listMemories({ q: input.q, category: input.category || undefined, since: since.value, until: until.value })
        if (!result.ok) return fail(res, result.error)
        return sendJson(res, 200, result)
      }

      if (route === '/confirm') {
        if (!validId(input.id)) return sendJson(res, 400, { ok: false, error: 'invalid' })
        const result = await consent.confirm(input.id, input.content === undefined ? {} : { content: input.content })
        if (!result.ok) return fail(res, result.error)
        return sendJson(res, 200, { ok: true, item: result.record, warning: result.warning })
      }

      if (route === '/reject') {
        if (!validId(input.id)) return sendJson(res, 400, { ok: false, error: 'invalid' })
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.length <= 200 ? input.sessionId : undefined
        const result = await consent.reject(input.id, { sessionId })
        return sendJson(res, 200, { ok: true, removed: result.removed === true })
      }

      if (route === '/update') {
        if (!validId(input.id) || typeof input.content !== 'string') return sendJson(res, 400, { ok: false, error: 'invalid' })
        const result = await consent.update(input.id, input.content)
        if (!result.ok) return fail(res, result.error)
        return sendJson(res, 200, { ok: true, item: result.record })
      }

      if (route === '/delete') {
        if (!validId(input.id)) return sendJson(res, 400, { ok: false, error: 'invalid' })
        const result = await consent.remove(input.id)
        if (!result.ok) return fail(res, result.error)
        return sendJson(res, 200, { ok: true, warning: result.warning })
      }

      if (route === '/delete-all') {
        if (input.confirm !== 'DELETE') return sendJson(res, 400, { ok: false, error: 'invalid' })
        const result = await consent.removeAll()
        return sendJson(res, 200, { ok: true, deleted: result.deleted })
      }

      if (route === '/settings') {
        const patch = {}
        if (input.enabled !== undefined) patch.enabled = input.enabled
        if (input.normalMode !== undefined) patch.normalMode = input.normalMode
        const unknown = Object.keys(input).filter((key) => key !== 'enabled' && key !== 'normalMode')
        if (unknown.length > 0) return sendJson(res, 400, { ok: false, error: 'invalid' })
        const result = await consent.updateSettings(patch)
        if (!result.ok) return fail(res, result.error)
        return sendJson(res, 200, { ok: true, settings: result.settings })
      }

      if (route === '/rebuild-index') {
        const result = await consent.rebuildIndex()
        if (!result.ok) return fail(res, result.error)
        return sendJson(res, 200, { ok: true, backend: result.backend, rebuilt: result.rebuilt })
      }

      return sendJson(res, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      // 任何未预期错误：只记录错误码，不记录用户内容、不返回内部细节。
      log(`chengmeng-memory: route failed (${error?.code ?? error?.name ?? 'unknown'})`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' })
      return undefined
    }
  }
}
