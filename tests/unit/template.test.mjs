import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  MAX_BODY_BYTES, ROUTE_PREFIX, apply, createEchoTool, createRouteHandler, validateEchoArgs,
} from '../../plugins/_template/index.js'

/** 最小的假 ctx：记录工具和路由，effect 立即执行并保存 disposer。 */
function fakeCtx({ rejection } = {}) {
  const tools = []
  const routes = []
  const disposers = []
  const scope = {
    get: (key) => ({
      webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } },
      connection: { requestRejection: () => rejection },
    })[key],
    effect: (fn) => { disposers.push(fn()) },
  }
  const ctx = {
    tools: { register: (tool) => { tools.push(tool); return () => tools.splice(tools.indexOf(tool), 1) } },
    effect: (fn) => { disposers.push(fn()) },
    inject: (_services, fn) => fn(scope),
  }
  return { ctx, tools, routes, dispose: () => disposers.splice(0).forEach((d) => d?.()) }
}

function fakeRes() {
  const res = { status: 0, headers: {}, body: '', headersSent: false }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true }
  res.end = (body) => { res.body = body ?? '' }
  return res
}

function fakeReq(method, url, { body, headers } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', ...headers }
  return req
}

test('apply 注册一个纯对象工具和一条路由，卸载后全部撤销', () => {
  const { ctx, tools, routes, dispose } = fakeCtx()
  apply(ctx, {})
  assert.equal(tools.length, 1)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, ROUTE_PREFIX)
  dispose()
  assert.equal(tools.length, 0)
  assert.equal(routes.length, 0)
})

test('apply 对未知配置项直接报错（配置必须严格校验）', () => {
  assert.throws(() => apply(fakeCtx().ctx, { surprise: true }), /未知配置项 surprise/)
  assert.throws(() => apply(fakeCtx().ctx, null), /必须是对象/)
})

test('工具：入参校验不抛异常，领域错误作为结果返回', async () => {
  const tool = createEchoTool()
  assert.equal(await tool.execute({ text: '你好' }, {}), 'echo: 你好')
  assert.match(await tool.execute({}, {}), /参数无效/)
  assert.match(await tool.execute({ text: 'x', extra: 1 }, {}), /只接受 text/)
  assert.match(await tool.execute({ text: 'x'.repeat(201) }, {}), /不能超过/)
  await assert.rejects(() => tool.execute({ text: 'x' }, { signal: { aborted: true } }), /已取消/)
  assert.equal(validateEchoArgs('nope').ok, false)
  assert.deepEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
  assert.equal(tool.parameters.additionalProperties, false)
})

test('路由：认证检查是第一件事，被拒绝时业务逻辑完全不执行', async () => {
  for (const rejection of [401, 403]) {
    let touched = false
    const handler = createRouteHandler({ requestRejection: () => rejection })
    const req = fakeReq('POST', `${ROUTE_PREFIX}/echo`, { body: { text: 'secret' } })
    req.on('data', () => { touched = true })
    const res = fakeRes()
    await handler(req, res)
    assert.equal(res.status, rejection)
    assert.doesNotMatch(res.body, /secret/)
    assert.equal(touched, false, '被拒绝的请求体不应被读取')
  }
})

test('路由：已认证的请求，方法、类型、体积、格式都有限制，响应不缓存', async () => {
  const handler = createRouteHandler({ requestRejection: () => undefined })
  const run = async (req) => { const res = fakeRes(); await handler(req, res); return res }

  const ok = await run(fakeReq('POST', `${ROUTE_PREFIX}/echo`, { body: { text: '你好' } }))
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), { text: '你好' })
  assert.equal(ok.headers['Cache-Control'], 'no-store')

  assert.equal((await run(fakeReq('GET', `${ROUTE_PREFIX}/ping`))).status, 200)
  assert.equal((await run(fakeReq('DELETE', `${ROUTE_PREFIX}/ping`))).status, 405)
  assert.equal((await run(fakeReq('GET', `${ROUTE_PREFIX}/nope`))).status, 404)
  assert.equal((await run(fakeReq('POST', `${ROUTE_PREFIX}/echo`, { body: '{}', headers: { 'content-type': 'text/plain' } }))).status, 415)
  assert.equal((await run(fakeReq('POST', `${ROUTE_PREFIX}/echo`, { body: 'not json' }))).status, 400)
  assert.equal((await run(fakeReq('POST', `${ROUTE_PREFIX}/echo`, { body: { text: '' } }))).status, 400)
  assert.equal((await run(fakeReq('POST', `${ROUTE_PREFIX}/echo`, { body: 'x'.repeat(MAX_BODY_BYTES + 1) }))).status, 413)
})

test('路由：处理器内部出错时返回 500，不泄露错误细节', async () => {
  const handler = createRouteHandler({ requestRejection: () => { throw new Error('内部细节：/secret/path') } })
  const res = fakeRes()
  await handler(fakeReq('GET', `${ROUTE_PREFIX}/ping`), res)
  assert.equal(res.status, 500)
  assert.doesNotMatch(res.body, /secret/)
})
