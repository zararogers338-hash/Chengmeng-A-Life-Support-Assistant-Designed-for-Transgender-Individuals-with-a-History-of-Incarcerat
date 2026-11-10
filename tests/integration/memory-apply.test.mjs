/**
 * 集成测试：用假 ctx 驱动 index.js 的 apply()。
 * - 注册了 3 个工具 + 1 条路由 + 1 个 Skill；
 * - 卸载后全部撤销；
 * - 未知配置项抛错；
 * - apply 本身不创建数据目录；没有 webServer 的假 ctx 不报错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply, ROUTE_PREFIX } from '../../plugins/memory-consent/index.js'

/** 最小的假 ctx：只提供 apply 需要的服务，effect 立即执行并保存 disposer。 */
function fakeCtx({ services = {} } = {}) {
  const tools = []
  const routes = []
  const skills = []
  const disposers = []
  const registry = {
    tools: {
      register: (tool) => {
        tools.push(tool)
        return () => {
          const index = tools.indexOf(tool)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    skills: {
      register: (skill) => {
        skills.push(skill)
        return () => {
          const index = skills.indexOf(skill)
          if (index >= 0) skills.splice(index, 1)
        }
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: { requestRejection: () => undefined },
    ...services,
  }
  const ctx = {
    get: (serviceName) => registry[serviceName],
    tools: registry.tools,
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    // 只有全部服务都存在时才执行回调（模拟真实 ctx.inject 的等待语义）。
    inject: (serviceNames, fn) => {
      const available = serviceNames.every(
        (serviceName) => registry[serviceName] !== undefined && registry[serviceName] !== null,
      )
      if (!available) return
      const scope = {
        get: (serviceName) => registry[serviceName],
        effect: (inner) => {
          const disposer = inner()
          if (typeof disposer === 'function') disposers.push(disposer)
        },
      }
      fn(scope)
    },
  }
  return {
    ctx,
    tools,
    routes,
    skills,
    dispose: () => disposers.splice(0).reverse().forEach((disposer) => disposer()),
  }
}

function fakeRes() {
  const res = { status: 0, headers: {}, body: '', headersSent: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    res.headersSent = true
  }
  res.end = (body) => {
    res.body = body === undefined ? '' : String(body)
  }
  return res
}

function fakeGetReq(url) {
  const req = Readable.from([])
  req.method = 'GET'
  req.url = url
  req.headers = {}
  return req
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('apply 注册 4 个工具、1 条路由、1 个 Skill；数据目录不被创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-apply-'))
  const dataDir = join(root, 'memory-data')
  try {
    const fake = fakeCtx()
    apply(fake.ctx, { dataDir })

    assert.deepEqual(
      fake.tools.map((tool) => tool.name),
      ['propose_memory', 'recall_memory', 'memory_status', 'recall_history'],
    )
    assert.equal(fake.routes.length, 1)
    assert.equal(fake.routes[0].kind, 'prefix')
    assert.equal(fake.routes[0].path, ROUTE_PREFIX)
    assert.equal(typeof fake.routes[0].handler, 'function')
    assert.equal(fake.skills.length, 1)
    assert.equal(fake.skills[0].name, 'memory-protocol')
    assert.equal(typeof fake.skills[0].content, 'string')
    assert.ok(fake.skills[0].content.length > 0)
    assert.ok(fake.skills[0].content.length <= 8192, 'Skill 正文不能超过 8192 字符')
    assert.equal(fake.skills[0].source, 'chengmeng-memory-consent')

    assert.equal(await pathExists(dataDir), false, 'apply 本身不能创建数据目录')
    assert.equal(await pathExists(root), true)

    // 卸载后工具、路由、Skill 全部撤销。
    fake.dispose()
    assert.deepEqual(fake.tools, [])
    assert.deepEqual(fake.routes, [])
    assert.deepEqual(fake.skills, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('未知配置项 / 非法枚举直接抛错（配置必须严格校验）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-apply-config-'))
  try {
    assert.throws(() => apply(fakeCtx().ctx, { surprise: true }), /未知配置项 surprise/)
    assert.throws(() => apply(fakeCtx().ctx, { backend: 'bogus' }), /backend 只能是/)
    assert.throws(() => apply(fakeCtx().ctx, { dataDir: 42 }), /dataDir 必须是字符串/)
    assert.throws(() => apply(fakeCtx().ctx, { memsearch: { nope: 1 } }), /未知配置项 memsearch\.nope/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('假 ctx 没有 webServer / connection / skills 时不报错，工具照常注册', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-apply-headless-'))
  const dataDir = join(root, 'memory-data')
  try {
    const fake = fakeCtx({ services: { webServer: undefined, connection: undefined, skills: undefined } })
    assert.doesNotThrow(() => apply(fake.ctx, { dataDir }))
    assert.equal(fake.tools.length, 4)
    assert.equal(fake.routes.length, 0)
    assert.equal(fake.skills.length, 0)
    assert.equal(await pathExists(dataDir), false)
    fake.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('注册的工具能执行：默认自动模式，来源不可核对时不捏造整理记忆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-apply-tools-'))
  const dataDir = join(root, 'memory-data')
  try {
    const fake = fakeCtx()
    apply(fake.ctx, { dataDir })

    const proposeTool = fake.tools.find((tool) => tool.name === 'propose_memory')
    const statusTool = fake.tools.find((tool) => tool.name === 'memory_status')

    const proposed = JSON.parse(
      await proposeTool.execute(
        {
          content: '默认关闭时不该写入的虚构内容',
          category: 'preference',
          user_quote: '虚构的用户原话',
          stated_by_user: true,
        },
        {},
      ),
    )
    assert.equal(proposed.status, 'rejected_by_policy')
    assert.match(proposed.message, /未能核对/)

    const status = JSON.parse(await statusTool.execute({}, {}))
    assert.equal(status.enabled, true)
    assert.equal(status.normalMode, 'auto')
    assert.equal(status.verification.kind, 'status_snapshot')
    assert.equal(status.verification.content_query, 'not_performed')
    assert.equal(status.verification.attachment_access, 'not_tested')
    assert.equal(status.pendingCount, 0)
    assert.doesNotMatch(JSON.stringify(status), /虚构内容/)

    assert.equal(await pathExists(dataDir), false, '默认关闭时工具调用不能创建数据目录')
    fake.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('注册的路由能处理请求：GET /status 返回 200，且不创建数据目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-apply-route-'))
  const dataDir = join(root, 'memory-data')
  try {
    const fake = fakeCtx()
    apply(fake.ctx, { dataDir })
    const handler = fake.routes[0].handler

    const res = fakeRes()
    await handler(fakeGetReq(`${ROUTE_PREFIX}/status`), res)
    assert.equal(res.status, 200)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.enabled, true)
    assert.equal(await pathExists(dataDir), false)
    fake.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('注册的路由带认证：requestRejection 返回 401 时直接拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chengmeng-apply-auth-'))
  const dataDir = join(root, 'memory-data')
  try {
    const fake = fakeCtx({ services: { connection: { requestRejection: () => 401 } } })
    apply(fake.ctx, { dataDir })
    const res = fakeRes()
    await fake.routes[0].handler(fakeGetReq(`${ROUTE_PREFIX}/status`), res)
    assert.equal(res.status, 401)
    assert.equal(res.headers['Cache-Control'], 'no-store')
    assert.equal(JSON.parse(res.body).error, 'unauthorized')
    fake.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
