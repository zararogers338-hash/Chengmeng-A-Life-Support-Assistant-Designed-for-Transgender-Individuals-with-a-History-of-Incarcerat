/**
 * 浏览器侧的记忆服务客户端：同源 fetch 封装 + 待确认候选的轮询。
 *
 * 约定（见 docs/prompts/memory-module.md 第 8 节）：
 * - 只请求同源相对路径 /chengmeng-memory/...，不拼任何外部地址；
 * - 响应一律 JSON、no-store；成功是 { ok:true, ... }，失败是 { ok:false, error:'<稳定 code>' }；
 * - 服务端错误只保留稳定的 code，界面一律显示中性的那一句，不回显服务端原文或用户内容。
 *
 * 本文件不依赖 React，构建脚本会把它内联进 lib/client.js；所有导出都必须写成顶层 export。
 */

/** 路由前缀（规范：HTTP 路由前缀 /chengmeng-<name>）。 */
export const MEMORY_API_PREFIX = '/chengmeng-memory'

/** 记忆类别：id 与中文名。类别名只在管理界面里出现，待确认卡片上绝不显示。 */
export const MEMORY_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'preference', label: '偏好' }),
  Object.freeze({ id: 'goal', label: '目标' }),
  Object.freeze({ id: 'episode', label: '经历' }),
  Object.freeze({ id: 'open_loop', label: '未解决的事' }),
  Object.freeze({ id: 'explicit', label: '明确要求记住的' }),
])

/**
 * 敏感原因的中文名（路由契约里 GET /memories 会带 reasons 的内部取值）。
 * 只在用户主动展开某条记忆的详情时才显示；列表行默认不显示，待确认卡片上也绝不显示。
 */
export const MEMORY_REASON_LABELS = Object.freeze({
  gender_identity: '身份认同',
  sexual_orientation: '性取向',
  medical: '医疗健康',
  mental_health: '心理状态',
  incarceration: '司法经历',
  trauma: '创伤经历',
  domestic_violence: '家庭安全',
  precise_location: '具体位置',
  family: '家庭关系',
  other_private: '其他私人信息',
})

/** 待确认候选的轮询间隔：页面可见且记忆已开启时每 2 秒一次。 */
export const MEMORY_PENDING_POLL_MS = 2000
/** 状态的轮询间隔：每 10 秒刷新一次，用来决定是否开始轮询候选。 */
export const MEMORY_STATUS_POLL_MS = 10000

/** 请求失败时抛出的错误：只带稳定的 code，不带服务端原文。构建器只剥 export const/function/let，所以类不导出。 */
class MemoryApiError extends Error {
  constructor(code) {
    super('记忆服务请求没有完成')
    this.name = 'MemoryApiError'
    this.code = typeof code === 'string' && code !== '' ? code : 'unknown'
  }
}

export function categoryLabel(category) {
  const found = MEMORY_CATEGORIES.find((item) => item.id === category)
  return found ? found.label : '其他'
}

/** 把 reasons 数组换成去重后的中性中文说法；未知原因一律不显示。 */
export function sensitivityReasonLabels(reasons) {
  if (!Array.isArray(reasons)) return []
  const labels = []
  for (const reason of reasons) {
    const label = MEMORY_REASON_LABELS[reason]
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；取不到或格式不对时返回空串。 */
export function formatMemoryTime(value) {
  if (typeof value !== 'string' || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 拼 /memories 的查询串：只接受字符串，空值不进 URL（敏感内容不进 query string）。 */
export function buildMemoryQuery(filters = {}) {
  const params = []
  for (const key of ['category', 'since', 'until']) {
    const value = filters[key]
    if (typeof value === 'string' && value.trim() !== '') params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  return params.length > 0 ? `?${params.join('&')}` : ''
}

/** 只允许拼同源相对路径；路径必须以 / 开头，防止调用方拼出外部地址。 */
function memoryPath(path) {
  if (typeof path !== 'string' || path === '' || path[0] !== '/' || path.startsWith('//')) {
    throw new MemoryApiError('invalid_request')
  }
  return `${MEMORY_API_PREFIX}${path}`
}

/**
 * 同源 fetch 封装。所有方法成功时返回服务端的 JSON，失败时抛 MemoryApiError。
 * fetchImpl 可注入，方便在没有浏览器 fetch 的环境里测试。
 */
export function createMemoryApi(fetchImpl) {
  const callFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  async function request(path, options = {}) {
    if (!callFetch) throw new MemoryApiError('unavailable')
    const method = options.method === 'POST' ? 'POST' : 'GET'
    const init = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }
    if (method === 'POST') {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body === undefined ? {} : options.body)
    }
    const response = await callFetch(memoryPath(path), init)
    if (!response || response.ok !== true) throw new MemoryApiError(`http_${response ? response.status : 0}`)
    let payload = null
    try {
      payload = await response.json()
    } catch {
      throw new MemoryApiError('invalid_response')
    }
    if (!payload || payload.ok !== true) {
      throw new MemoryApiError(payload && typeof payload.error === 'string' ? payload.error : 'unknown')
    }
    return payload
  }

  return {
    status: () => request('/status'),
    pending: (sessionId) => request(typeof sessionId === 'string'
      ? `/pending?sessionId=${encodeURIComponent(sessionId)}` : '/pending'),
    memories: (filters = {}) => request('/memories/search', { method: 'POST', body: filters }),
    confirm: (id, content) => request('/confirm', { method: 'POST', body: content === undefined ? { id } : { id, content } }),
    // 拒绝时带上 sessionId：服务端把"用户已拒绝"的内容指纹限制在本次会话内。
    reject: (id, sessionId) => request('/reject', {
      method: 'POST',
      body: typeof sessionId === 'string' && sessionId !== '' ? { id, sessionId } : { id },
    }),
    update: (id, content) => request('/update', { method: 'POST', body: { id, content } }),
    remove: (id) => request('/delete', { method: 'POST', body: { id } }),
    deleteAll: () => request('/delete-all', { method: 'POST', body: { confirm: 'DELETE' } }),
    saveSettings: (settings) => request('/settings', { method: 'POST', body: settings === undefined ? {} : settings }),
    historySettings: (enabled) => request('/history-settings', { method: 'POST', body: { enabled } }),
    historySearch: (args) => request('/history-query', { method: 'POST', body: args }),
    rebuildIndex: () => request('/rebuild-index', { method: 'POST', body: {} }),
  }
}

/** 下载导出文件：fetch → blob → 临时 a[download] 点击。文件名固定，不含用户内容。 */
export const downloadMemoryExport = async (format = 'md', options = {}) => {
  const callFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const doc = options.doc || (typeof document === 'undefined' ? null : document)
  if (typeof callFetch !== 'function' || !doc || !doc.body) throw new MemoryApiError('unavailable')
  const normalized = format === 'json' ? 'json' : 'md'
  const response = await callFetch(`${MEMORY_API_PREFIX}/export?format=${normalized}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response || response.ok !== true) throw new MemoryApiError(`http_${response ? response.status : 0}`)
  const blob = await response.blob()
  const url = globalThis.URL.createObjectURL(blob)
  const link = doc.createElement('a')
  link.href = url
  link.download = normalized === 'json' ? 'chengmeng-memory-export.json' : 'chengmeng-memory-export.md'
  link.rel = 'noopener'
  doc.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    globalThis.setTimeout(() => {
      try {
        globalThis.URL.revokeObjectURL(url)
      } catch {
        // 释放失败不影响已经开始的下载
      }
    }, 0)
  }
  return normalized
}

/** 列表接口 → 界面用的字段名；未知字段一律丢掉，不让服务端的多余字段进界面。 */
export function normalizeMemoryItem(item) {
  return {
    id: typeof item.id === 'string' ? item.id : '',
    content: typeof item.content === 'string' ? item.content : '',
    category: typeof item.category === 'string' ? item.category : '',
    sensitivity: item.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
    reasons: Array.isArray(item.reasons) ? item.reasons.filter((reason) => typeof reason === 'string') : [],
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    source: typeof item.source === 'string' ? item.source : '',
    confirmedByUser: item.confirmed_by_user === true,
    savedAutomatically: item.saved_automatically === true,
    editedByUser: item.edited_by_user === true,
  }
}

/** 待确认接口 → 界面用的字段名；server 按 created_at 升序返回，这里保持顺序。 */
export function normalizePendingItem(item) {
  return {
    id: typeof item.id === 'string' ? item.id : '',
    content: typeof item.content === 'string' ? item.content : '',
    sensitivity: item.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
    createdAt: item.created_at,
    source: typeof item.source === 'string' ? item.source : '',
    // 只有明确 true 才算已核对；false 和 unknown 用同一句中性说明。
    quoteVerified: item.quote_verified === true ? true : item.quote_verified === 'unknown' ? 'unknown' : false,
  }
}

function emptyMemorySnapshot() {
  return Object.freeze({
    ready: false,
    enabled: false,
    normalMode: 'confirm',
    pendingCount: 0,
    degraded: false,
    backend: '',
    pending: [],
    dismissed: false,
    statusFailed: false,
    pendingFailed: false,
  })
}

/**
 * 待确认候选的轮询与订阅。
 *
 * 规则（提示词第 10 节）：
 * - 页面可见且记忆已开启时每 2 秒 GET /pending；页面隐藏时暂停；
 * - GET /status 每 10 秒刷新一次，用来决定是否开始轮询；
 * - 同一类请求不重叠（in-flight 保护）；
 * - stop() 清掉全部定时器和监听器，卸载后不再请求。
 *
 * 组件通过 subscribe / getSnapshot 订阅（配合 useSyncExternalStore）。
 * 返回的 api 也挂在 store 上，界面动作（确认/拒绝/设置）直接用它。
 */
export function createMemoryStore(options = {}) {
  const api = options.api || createMemoryApi()
  const doc = options.doc !== undefined ? options.doc : (typeof document === 'undefined' ? null : document)
  const win = options.win !== undefined ? options.win : (typeof window === 'undefined' ? null : window)
  const timers = options.timers || null
  const setIntervalFn = timers && typeof timers.setInterval === 'function'
    ? timers.setInterval
    : ((fn, ms) => (win ? win.setInterval(fn, ms) : 0))
  const clearIntervalFn = timers && typeof timers.clearInterval === 'function'
    ? timers.clearInterval
    : ((id) => { if (win) win.clearInterval(id) })

  const listeners = new Set()
  let snapshot = emptyMemorySnapshot()
  let statusTimer = 0
  let pendingTimer = 0
  let statusInFlight = false
  let pendingInFlight = false
  let started = false

  const pageVisible = () => !doc || doc.visibilityState !== 'hidden'

  const emit = () => {
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch {
        // 某个订阅者出错不能影响其他订阅者和轮询
      }
    }
  }

  const setSnapshot = (patch) => {
    snapshot = Object.freeze({ ...snapshot, ...patch })
    emit()
  }

  const clearPendingTimer = () => {
    if (pendingTimer) {
      clearIntervalFn(pendingTimer)
      pendingTimer = 0
    }
  }

  const pollPending = async () => {
    if (pendingInFlight || !snapshot.enabled || !pageVisible()) return false
    pendingInFlight = true
    try {
      if (options.sessionId === '') return false
      const payload = await api.pending(options.sessionId)
      const items = Array.isArray(payload.items) ? payload.items.map(normalizePendingItem).filter((item) => item.id !== '') : []
      // 每次轮询都把「收起」状态清掉：Esc 只是暂时收起，候选仍在队列里。
      setSnapshot({ pending: items, pendingCount: items.length, pendingFailed: false, dismissed: false })
      return true
    } catch {
      setSnapshot({ pendingFailed: true })
      return false
    } finally {
      pendingInFlight = false
    }
  }

  const syncPendingTimer = () => {
    const shouldRun = started && snapshot.enabled && pageVisible()
    if (shouldRun) {
      if (!pendingTimer) {
        pendingTimer = setIntervalFn(() => { void pollPending() }, MEMORY_PENDING_POLL_MS)
        void pollPending()
      }
    } else {
      clearPendingTimer()
    }
  }

  const pollStatus = async () => {
    if (statusInFlight) return false
    statusInFlight = true
    try {
      const payload = await api.status()
      const enabled = payload.enabled === true
      setSnapshot({
        ready: true,
        enabled,
        normalMode: payload.normalMode === 'auto' ? 'auto' : 'confirm',
        pendingCount: Number.isFinite(payload.pendingCount) ? payload.pendingCount : 0,
        degraded: payload.degraded === true,
        backend: typeof payload.backend === 'string' ? payload.backend : '',
        statusFailed: false,
      })
      if (!enabled) setSnapshot({ pending: [], pendingCount: 0, dismissed: false })
      syncPendingTimer()
      return true
    } catch {
      setSnapshot({ statusFailed: true })
      return false
    } finally {
      statusInFlight = false
    }
  }

  const onVisibilityChange = () => {
    if (!started) return
    if (pageVisible()) {
      void pollStatus()
    } else {
      clearPendingTimer()
    }
  }

  const start = () => {
    if (started || !win) return
    started = true
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibilityChange)
    void pollStatus()
    statusTimer = setIntervalFn(() => { void pollStatus() }, MEMORY_STATUS_POLL_MS)
  }

  const stop = () => {
    started = false
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibilityChange)
    if (statusTimer) {
      clearIntervalFn(statusTimer)
      statusTimer = 0
    }
    clearPendingTimer()
  }

  const store = {
    api,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start,
    stop,
    /** 收起卡片：不等于拒绝，候选仍在队列里，下次轮询还会出现。 */
    dismiss() {
      if (snapshot.dismissed || snapshot.pending.length === 0) return
      setSnapshot({ dismissed: true })
    },
    /** 本地先移掉已经处理过的候选，让界面立即切到下一条，再重新拉一次列表。 */
    forget(id) {
      const next = snapshot.pending.filter((item) => item.id !== id)
      setSnapshot({ pending: next, pendingCount: next.length, dismissed: false })
    },
    refreshPending() {
      void pollPending()
    },
    refresh() {
      void pollStatus()
      void pollPending()
    },
  }
  return store
}
