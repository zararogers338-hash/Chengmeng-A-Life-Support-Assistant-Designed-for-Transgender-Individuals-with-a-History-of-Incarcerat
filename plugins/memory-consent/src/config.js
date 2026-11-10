/**
 * 配置：严格校验 cordis.patch.yml 里的 `config:`，并把数据目录解析成绝对路径。
 *
 * 规则（docs/DEV_STANDARDS.md 第 3 节）：
 * - 未知字段直接报错，缺省值写在代码里，类型不对直接报错。
 * - 数据目录与会话工作目录无关：`dataDir` 为空时取 <DSH_HOME>/chengmeng/memory，
 *   DSH_HOME 取环境变量（空字符串视为未设置），再退回 ~/.dsh。
 * - `dataDir` 只接受绝对路径或 `~` 开头的路径；相对路径会被拒绝，因为那会让"数据在哪"
 *   取决于进程工作目录，违反隔离要求。
 */

import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

/** 可选的检索后端。 */
export const BACKENDS = Object.freeze(['keyword', 'memsearch', 'hybrid', 'qwen-hybrid'])

/** 默认配置。用户在界面里改的 enabled / normalMode 不在这里，存在数据目录的 settings.json。 */
export const DEFAULT_CONFIG = Object.freeze({
  dataDir: '',
  backend: 'keyword',
  routePrefix: '/chengmeng-memory',
  timeZone: 'Asia/Shanghai',
  historyPreset: 'chengmeng',
  historyWorkspace: '',
  qwen: Object.freeze({ python: '', modelDir: '', dimensions: 1024, threads: 4,
    maxTokens: 2048, batchSize: 2, timeoutMs: 30000, idleMs: 120000, minScore: 0.35, minFreeMemoryMb: 4096 }),
  memsearch: Object.freeze({
    command: '',
    provider: 'onnx',
    milvusUri: '',
    timeoutMs: 8000,
  }),
  pendingTtlHours: 24,
  maxContentChars: 280,
})

/** 数据目录相对 DSH_HOME 的固定位置：<DSH_HOME>/chengmeng/memory。 */
export const DATA_SUBDIR = Object.freeze(['chengmeng', 'memory'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

/** 展开开头的 `~`、`~/`、`~\`；其余保持原样。 */
export function expandTilde(value, home = homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

/**
 * 校验并规范化配置。未知字段/类型错误/枚举越界一律抛异常（插件加载失败，而不是带着坏配置运行）。
 * @param {unknown} raw apply(ctx, config) 收到的原始配置。
 * @returns {{ dataDir: string, backend: string, memsearch: { command: string, provider: string, milvusUri: string, timeoutMs: number }, pendingTtlHours: number, maxContentChars: number }}
 */
export function validateConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(input)) throw new Error('chengmeng-memory-consent: config 必须是对象')

  const topUnknown = unknownKeys(input, Object.keys(DEFAULT_CONFIG))
  if (topUnknown.length > 0) throw new Error(`chengmeng-memory-consent: 未知配置项 ${topUnknown.join(', ')}`)

  const dataDir = input.dataDir === undefined ? DEFAULT_CONFIG.dataDir : input.dataDir
  if (typeof dataDir !== 'string') throw new Error('chengmeng-memory-consent: config.dataDir 必须是字符串')

  const backend = input.backend === undefined ? DEFAULT_CONFIG.backend : input.backend
  const routePrefix = input.routePrefix ?? DEFAULT_CONFIG.routePrefix
  if (typeof routePrefix !== 'string' || !/^\/[a-z][a-z0-9-]{1,63}$/.test(routePrefix)) throw new Error('INVALID_ROUTE_PREFIX')
  if (!BACKENDS.includes(backend)) {
    throw new Error(`chengmeng-memory-consent: config.backend 只能是 ${BACKENDS.join(' | ')}`)
  }

  const memsearchInput = input.memsearch === undefined ? {} : input.memsearch
  if (!isPlainObject(memsearchInput)) throw new Error('chengmeng-memory-consent: config.memsearch 必须是对象')
  const memsearchUnknown = unknownKeys(memsearchInput, Object.keys(DEFAULT_CONFIG.memsearch))
  if (memsearchUnknown.length > 0) {
    throw new Error(`chengmeng-memory-consent: 未知配置项 memsearch.${memsearchUnknown.join(', memsearch.')}`)
  }
  const command = memsearchInput.command === undefined ? '' : memsearchInput.command
  if (typeof command !== 'string') throw new Error('chengmeng-memory-consent: config.memsearch.command 必须是字符串')
  const provider = memsearchInput.provider === undefined ? 'onnx' : memsearchInput.provider
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('chengmeng-memory-consent: config.memsearch.provider 必须是非空字符串')
  }
  const milvusUri = memsearchInput.milvusUri === undefined ? '' : memsearchInput.milvusUri
  if (typeof milvusUri !== 'string') throw new Error('chengmeng-memory-consent: config.memsearch.milvusUri 必须是字符串')
  const timeoutMs = memsearchInput.timeoutMs === undefined ? DEFAULT_CONFIG.memsearch.timeoutMs : memsearchInput.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new Error('chengmeng-memory-consent: config.memsearch.timeoutMs 必须是 100–60000 之间的整数')
  }

  const pendingTtlHours = input.pendingTtlHours === undefined ? DEFAULT_CONFIG.pendingTtlHours : input.pendingTtlHours
  if (typeof pendingTtlHours !== 'number' || !Number.isFinite(pendingTtlHours) || pendingTtlHours <= 0 || pendingTtlHours > 24 * 365) {
    throw new Error('chengmeng-memory-consent: config.pendingTtlHours 必须是大于 0 的有限数')
  }

  const maxContentChars = input.maxContentChars === undefined ? DEFAULT_CONFIG.maxContentChars : input.maxContentChars
  if (!Number.isInteger(maxContentChars) || maxContentChars < 1 || maxContentChars > 4000) {
    throw new Error('chengmeng-memory-consent: config.maxContentChars 必须是 1–4000 之间的整数')
  }

  const timeZone = input.timeZone ?? DEFAULT_CONFIG.timeZone
  const historyPreset = input.historyPreset ?? DEFAULT_CONFIG.historyPreset
  const historyWorkspace = input.historyWorkspace ?? DEFAULT_CONFIG.historyWorkspace
  if (typeof historyWorkspace !== 'string' || (historyWorkspace && !isAbsolute(historyWorkspace))) throw new Error('INVALID_HISTORY_WORKSPACE')
  if (typeof historyPreset !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(historyPreset)) throw new Error('INVALID_HISTORY_PRESET')
  if (typeof timeZone !== 'string') throw new Error('INVALID_TIME_ZONE')
  try { new Intl.DateTimeFormat('en', { timeZone }).format() } catch { throw new Error('INVALID_TIME_ZONE') }
  const qwenInput = input.qwen ?? {}
  if (!isPlainObject(qwenInput) || unknownKeys(qwenInput, Object.keys(DEFAULT_CONFIG.qwen)).length) throw new Error('INVALID_QWEN_CONFIG')
  const qwen = { ...DEFAULT_CONFIG.qwen, ...qwenInput }
  for (const field of ['python', 'modelDir']) {
    if (typeof qwen[field] !== 'string' || (qwen[field] && !isAbsolute(qwen[field]))) throw new Error('INVALID_QWEN_PATH')
  }
  for (const [field, min, max] of [['dimensions', 32, 1024], ['threads', 1, 16], ['maxTokens', 64, 8192],
    ['batchSize', 1, 8], ['timeoutMs', 100, 120000], ['idleMs', 1000, 600000], ['minFreeMemoryMb', 0, 131072]]) {
    if (!Number.isInteger(qwen[field]) || qwen[field] < min || qwen[field] > max) throw new Error('INVALID_QWEN_CONFIG')
  }
  if (!Number.isFinite(qwen.minScore) || qwen.minScore < 0 || qwen.minScore > 1) throw new Error('INVALID_QWEN_CONFIG')

  return {
    dataDir,
    backend,
    routePrefix,
    timeZone,
    historyPreset,
    historyWorkspace,
    qwen,
    memsearch: { command, provider, milvusUri, timeoutMs },
    pendingTtlHours,
    maxContentChars,
  }
}

/**
 * 解析数据目录的绝对路径。会话工作目录绝不参与。
 * @param {{ dataDir?: string }} config 已校验的配置。
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveDataDir(config, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured !== '') {
    const expanded = expandTilde(configured, home)
    if (!isAbsolute(expanded)) {
      throw new Error('chengmeng-memory-consent: config.dataDir 必须是绝对路径（或以 ~ 开头）')
    }
    return normalize(expanded)
  }
  const dshHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = dshHome === '' ? join(home, '.dsh') : expandTilde(dshHome, home)
  return normalize(join(root, ...DATA_SUBDIR))
}
