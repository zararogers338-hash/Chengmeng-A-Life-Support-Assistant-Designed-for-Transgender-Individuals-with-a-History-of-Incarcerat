/**
 * Chengmeng 模块骨架（Node 侧入口）。
 *
 * 演示三件事，都在 DSH 0.2.2-rc.1 里实际加载验证过：
 *   1. 用「纯对象」注册模型可调用的工具。不 import 任何 `@deepseek-ai/dsh-*` 包：
 *      第三方插件在 Profile 里只能指望 `@deepseek-ai/schemastery` 和 `cosmokit` 可解析，
 *      官方 MemSearch 插件和 dsh-vision-router 也都是这样写的。
 *      原始 JSON Schema 工具要自己校验入参（DSH 文档：Raw JSON-Schema tools own their input validation）。
 *   2. 注册 HTTP 路由，并且在处理任何请求之前先调用 `ctx.connection.requestRejection(req)`。
 *      DSH 不会替插件自己注册的路由做认证：不调用它，路由就对本机任何程序开放。
 *   3. `apply` 只做注册，所有逻辑放进可单独测试的函数里（见 tests/unit/template.test.mjs，用假 ctx 驱动）。
 *
 * 规范见 docs/DEV_STANDARDS.md。
 */

export const name = 'chengmeng-template'
// 工具注册表是硬依赖；webServer / connection 是可选的（无头模式没有它们），在 apply 里用 ctx.inject 等待。
export const inject = ['tools']

export const ROUTE_PREFIX = '/chengmeng-template'
export const MAX_BODY_BYTES = 16 * 1024
export const MAX_TEXT_CHARS = 200

/** 工具入参校验：返回 { ok: true, value } 或 { ok: false, error }。永远不抛。 */
export function validateEchoArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: '参数必须是对象' }
  const keys = Object.keys(args)
  if (keys.some((key) => key !== 'text')) return { ok: false, error: '只接受 text 一个参数' }
  if (typeof args.text !== 'string' || args.text.trim() === '') return { ok: false, error: 'text 必须是非空字符串' }
  if (args.text.length > MAX_TEXT_CHARS) return { ok: false, error: `text 不能超过 ${MAX_TEXT_CHARS} 个字符` }
  return { ok: true, value: { text: args.text } }
}

/** 工具定义。纯对象，没有任何 import，所以可以直接在 node:test 里调用 execute。 */
export function createEchoTool() {
  return {
    name: 'template_echo',
    description: '骨架示例：原样返回传入的文字。真实模块请替换为自己的工具，并把"什么时候该调用、什么时候不该调用"写清楚。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要返回的文字，最多 200 个字符' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('调用已取消')
      const checked = validateEchoArgs(args)
      // 领域内的"不合格输入"作为成功结果返回，让模型能读到原因并改正；基础设施故障才抛。
      if (!checked.ok) return `参数无效：${checked.error}`
      return `echo: ${checked.value.text}`
    },
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    // 记忆一类的数据绝不能被缓存。
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

/**
 * 创建路由处理器。connection 是 ctx.connection（或测试里的替身）。
 * 规则：认证检查是处理器的第一件事；只接受 GET 读和 POST 写；POST 必须是 JSON 且有体积上限；
 * 响应永不缓存；错误信息不回显用户输入。
 */
export function createRouteHandler(connection) {
  return async function handler(req, res) {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) return sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })

      const path = new URL(req.url ?? '/', 'http://chengmeng.invalid').pathname
      if (req.method === 'GET' && path === `${ROUTE_PREFIX}/ping`) return sendJson(res, 200, { ok: true })

      if (req.method === 'POST' && path === `${ROUTE_PREFIX}/echo`) {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { error: 'content-type must be application/json' })
        }
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (body.error) return sendJson(res, body.error, { error: body.error === 413 ? 'too large' : 'bad json' })
        const checked = validateEchoArgs(body.value)
        if (!checked.ok) return sendJson(res, 400, { error: checked.error })
        return sendJson(res, 200, { text: checked.value.text })
      }

      return sendJson(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'not found' })
    } catch {
      // 任何未预期的错误都不能把内部细节或用户数据写进响应。
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    }
  }
}

export function apply(ctx, config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('chengmeng-template: config 必须是对象')
  if (Object.keys(config).length > 0) throw new Error(`chengmeng-template: 未知配置项 ${Object.keys(config).join(', ')}`)

  ctx.effect(() => ctx.tools.register(createEchoTool()), 'chengmeng-template: tools')

  ctx.inject(['webServer', 'connection'], (scope) => {
    const server = scope.get('webServer')
    const connection = scope.get('connection')
    scope.effect(
      () => server.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(connection) }),
      'chengmeng-template: http route',
    )
  })
}
