/**
 * Chengmeng 记忆授权模块（Node 侧入口）。
 *
 * `apply` 只做注册：工具、HTTP 路由、Skill。所有逻辑都在 src/ 的纯函数里，
 * 通过参数注入依赖，所以 tests/ 里可以用假 ctx、假 store 直接测。
 *
 * 隐私边界（详见 docs/modules/memory-consent.md）：
 * - 模块本身不发任何网络请求、不调用语言模型、不做自动摘要或自动提取；
 * - 自动模式将有来源的整理内容直接写入 memory/，标明 saved_automatically；
 * - 两个开关都关闭时，不因对话产生记忆文件（apply 也不创建数据目录）；
 *   自动聊天记忆默认开启，随消息变化归档并后台建立索引。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateConfig, resolveDataDir } from './src/config.js'
import { createStore } from './src/store.js'
import { createKeywordBackend } from './src/backends/keyword.js'
import { createMemsearchBackend, collectionNameFor } from './src/backends/memsearch.js'
import { createHybridBackend } from './src/backends/hybrid.js'
import { createSearchService } from './src/search.js'
import { createConsentService } from './src/consent.js'
import { createMemoryTools } from './src/tools.js'
import { createRouteHandler, ROUTE_PREFIX, MAX_BODY_BYTES } from './src/routes.js'
import { createQuoteVerifier } from './src/quotes.js'
import { createQwenBackend } from './src/backends/qwen.js'
import { createQwenEncoder } from './src/backends/qwen-encoder.js'
import { createHistoryService } from './src/history.js'

export const name = 'chengmeng-memory-consent'

// 工具注册表是硬依赖；webServer / connection / skills / agents / sessionQuery 都是可选的，
// 在 apply 里用 ctx.inject 等待（无头模式没有 web 服务时，插件仍然能加载并注册工具）。
export const inject = ['tools']

export { ROUTE_PREFIX, MAX_BODY_BYTES }

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

/** 取可选服务；未安装时返回 undefined，不抛错。 */
function getService(ctx, serviceName) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(serviceName)
  } catch {
    // 服务还没就绪/已被销毁，按"没有"处理。
  }
  try {
    return ctx[serviceName]
  } catch {
    return undefined
  }
}

function makeLogger(ctx) {
  const safe = (level) => (message) => {
    try {
      ctx?.logger?.[level]?.(message)
    } catch {
      // 日志失败不影响业务。
    }
  }
  return { warn: safe('warn'), info: safe('info') }
}

/**
 * 从 Agent 会话取提议来源：`session:<id>#turn:<n>`；取不到时 `session:unknown`。
 * 依据（读 DSH 0.2.2-rc.1 源码核实）：`exec.agent.session` 是会话对象，
 * `ctx.agents.turnBoundaryOf(session).lastTurn` 是当前轮次号。
 */
function makeResolveContext(ctx, captured = {}) {
  return (exec) => {
    const session = exec?.agent?.session
    const sessionId = typeof session?.id === 'string' && session.id !== '' ? session.id : undefined
    let turn = 0
    try {
      const agents = captured.agents ?? getService(ctx, 'agents')
      if (session && agents && typeof agents.turnBoundaryOf === 'function') {
        const boundary = agents.turnBoundaryOf(session)
        if (Number.isInteger(boundary?.lastTurn) && boundary.lastTurn >= 0) turn = boundary.lastTurn
      }
    } catch {
      // 取不到轮次号不影响提议本身，source 里的 turn 记 0。
    }
    return { sessionId, turn, signal: exec?.signal }
  }
}

/** 按配置选择检索后端；memsearch 未配置时整个后端不存在，hybrid 降级为关键词并如实标记。 */
function selectBackend(configured, keyword, memsearch, logger) {
  if (configured === 'memsearch' && memsearch) return { backend: memsearch, backendName: 'memsearch' }
  if (configured === 'hybrid' && memsearch) {
    return { backend: createHybridBackend({ keyword, memsearch }), backendName: 'hybrid' }
  }
  if (configured !== 'keyword') {
    // 配了 memsearch/hybrid 但没有 command：只用关键词后端，并在 status 里如实报告降级。
    logger.warn('chengmeng-memory: memsearch 未配置，已降级为关键词后端')
    const degraded = {
      add: (record) => keyword.add(record),
      remove: (id) => keyword.remove(id),
      search: (query, options) => keyword.search(query, options),
      rebuild: (records) => keyword.rebuild(records),
      // 索引状态委托给真正的 keyword 后端：检索前的自愈才能判断"索引是否需要重建"。
      isIndexed: () => keyword.isIndexed(),
      health: async () => ({ ...(await keyword.health()), ok: true, degraded: true }),
    }
    return { backend: degraded, backendName: 'keyword' }
  }
  return { backend: keyword, backendName: 'keyword' }
}

function registerSkill(ctx, logger) {
  let content
  try {
    content = readFileSync(join(PLUGIN_ROOT, 'skills', 'memory-protocol', 'SKILL.md'), 'utf8')
  } catch {
    // 没有 Skill 文件就静默跳过，不能拖住插件加载。
    return
  }
  if (content.length > 8192) {
    logger.warn('chengmeng-memory: Skill 正文超过 8192 字符，可能被 DSH 裁剪')
  }
  ctx.inject(['skills'], (scope) => {
    const skills = scope.get('skills')
    if (!skills || typeof skills.register !== 'function') return
    try {
      scope.effect(
        () =>
          skills.register({
            name: 'memory-protocol',
            title: '记忆协议',
            description: '什么时候提议长期记忆、什么时候检索、以及绝不能做的推断与存储。',
            whenToUse: '在对话中考虑要不要记住用户说过的事，或需要回忆以前的信息时。',
            source: 'chengmeng-memory-consent',
            content,
          }),
        'chengmeng-memory-consent: skill memory-protocol',
      )
    } catch (error) {
      logger.warn(`chengmeng-memory: Skill 注册失败 (${error?.code ?? 'unknown'})`)
    }
  })
}

/**
 * 插件入口：只做注册。
 * @param {object} ctx DSH Cordis 上下文。
 * @param {object} [config] cordis.patch.yml 里的 config。
 */
export function apply(ctx, config = {}) {
  const validated = validateConfig(config)
  const dataDir = resolveDataDir(validated)
  const logger = makeLogger(ctx)
  const clock = () => new Date()

  const store = createStore({
    dataDir,
    pendingTtlHours: validated.pendingTtlHours,
    maxContentChars: validated.maxContentChars,
    clock,
    defaultSettings: { version: 1, enabled: true, normalMode: 'auto' },
  })

  // 关键词后端总是存在（默认后端，也是 hybrid 的后备）。
  const keyword = createKeywordBackend({ dataDir })
  const memsearch =
    validated.memsearch.command.trim() === ''
      ? null
      : createMemsearchBackend({
          command: validated.memsearch.command.trim(),
          provider: validated.memsearch.provider,
          milvusUri: validated.memsearch.milvusUri,
          timeoutMs: validated.memsearch.timeoutMs,
          collection: collectionNameFor(dataDir),
          memoryDir: join(dataDir, 'memory'),
          clock,
        })

  let selected, qwenConfig = null, encoder = null
  if (validated.backend === 'qwen-hybrid') {
    const runtime = resolve(PLUGIN_ROOT, '../../.runtime/qwen-embedding')
    const config = { ...validated.qwen,
      python: validated.qwen.python || join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      modelDir: validated.qwen.modelDir || join(runtime, 'model') }
    qwenConfig = config
    encoder = createQwenEncoder(config)
    const qwen = createQwenBackend({ dataDir, config, encoder, getRecords: async () => (await store.listMemories()).records })
    ctx.effect(() => () => qwen.dispose(), 'chengmeng memory: CPU embedding worker')
    const hybrid = createHybridBackend({ keyword, memsearch: qwen })
    selected = { backendName: 'qwen-hybrid', backend: { ...hybrid,
      async health() {
        const embedding = await qwen.health()
        return { ok: embedding.ok, backend: 'qwen-hybrid', degraded: !embedding.ok, embedding }
      } } }
  } else selected = selectBackend(validated.backend, keyword, memsearch, logger)

  /**
   * 索引自愈包装：关键词索引是派生数据，允许用户把 index/ 整个删掉。
   * 检索前发现索引不可用（文件缺失/损坏/从未构建）就先从 memory/*.md 全量重建，
   * 这样「删掉 index 目录」不会让记忆检索直接失效。
   */
  const rebuildFromTruth = async () => {
    const { records } = await store.listMemories()
    await selected.backend.rebuild(records)
    return records.length
  }
  const searchBackend = {
    name: selected.backendName,
    add: (record) => selected.backend.add(record),
    remove: (id) => selected.backend.remove(id),
    rebuild: (records) => selected.backend.rebuild(records),
    health: () => selected.backend.health(),
    async search(query, options) {
      try {
        if (typeof selected.backend.isIndexed === 'function' && !(await selected.backend.isIndexed())) {
          await rebuildFromTruth()
        }
      } catch {
        // 自愈失败就让后端自己处理；检索失败会在 search 服务里降级，不崩。
      }
      return selected.backend.search(query, options)
    },
  }

  const search = createSearchService({
    backend: searchBackend,
    getRecord: (id) => store.getMemory(id),
    rebuildKeyword: rebuildFromTruth,
  })

  const verifyQuote = createQuoteVerifier({ getSessionQuery: () => getService(ctx, 'sessionQuery'), includeSourceTime: true })
  const history = createHistoryService({ dataDir, getSessionQuery: () => getService(ctx, 'sessionQuery'),
    qwenConfig, encoder, timeZone: validated.timeZone, clock, presetId: validated.historyPreset, workspace: validated.historyWorkspace })
  const consent = createConsentService({
    store,
    backend: searchBackend,
    search,
    clock,
    maxContentChars: validated.maxContentChars,
    verifyQuote,
    backendName: selected.backendName,
    timeZone: validated.timeZone,
    history,
    logger,
  })

  const captured = {}
  ctx.inject(['agents'], (scope) => {
    captured.agents = scope.get('agents')
  })
  ctx.inject(['sessionQuery'], (scope) => {
    captured.sessionQuery = scope.get('sessionQuery')
    history.schedule()
  })
  ctx.effect(() => {
    const off = ctx.on('session/event', (_session, event) => {
      if (['user/message', 'assistant/message', 'tool/result', 'turn/end'].includes(event.type)) history.schedule()
    })
    return () => { off(); history.dispose() }
  }, 'automatic conversation memory')

  const resolveContext = makeResolveContext(ctx, captured)
  const tools = createMemoryTools({
    consent,
    resolveContext,
    maxContentChars: validated.maxContentChars,
    history,
  })
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `chengmeng-memory-consent: tool ${tool.name}`)
  }

  registerSkill(ctx, logger)

  ctx.inject(['webServer', 'connection'], (scope) => {
    const server = scope.get('webServer')
    const connection = scope.get('connection')
    const handler = createRouteHandler({ connection, consent, history, logger, routePrefix: validated.routePrefix })
    scope.effect(
      () => server.register({ kind: 'prefix', path: validated.routePrefix, handler }),
      'chengmeng-memory-consent: http route',
    )
  })
}
