// DSH 客户端入口。构建时会被拼接在 springs.js、config.js、schedule.js、startup.js 之后，
// 包进 window.__ModuleLoader__.load 的 factory 里，所以可以直接使用它们的顶层符号。
// `require` 由模块加载器传入，只用来取宿主自带的 react。

const name = '@chengmeng/dsh-startup-animation'
// slots：官方覆盖层槽位所在的服务。connection：Host 连接状态，是"主机连接"这一项检查的真实信号。
const inject = ['slots', 'connection']

/**
 * 检查项。每一项都是真实信号，不是定时器：
 *  - 字体：document.fonts.ready。字体没到就开始显示文字，会在动画结束后出现一次字体切换的跳动。
 *  - 主机连接：ctx.connection.generation 有了活跃的代（DSH 与 Host 的事件通道已建立）。
 *  - 对话界面：输入框卡片已经挂载。
 * 记忆模块已安装时，额外检查同源只读状态接口；关闭记忆也可以是健康状态。
 */
function fontsCheck() {
  return {
    id: 'fonts', label: '字体', code: 'fonts',
    wait: () => (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()),
  }
}

function hostCheck(ctx) {
  return {
    id: 'host', label: '主机连接', code: 'host link',
    wait: (signal) => new Promise((resolve) => {
      const generation = ctx.connection && ctx.connection.generation
      if (!generation) return // 取不到连接状态：不冒充"已就绪"，这一行会在退场时显示"超时"
      const ready = () => generation.getSnapshot() !== undefined
      if (ready()) return resolve()
      const off = generation.subscribe(() => { if (ready()) { off(); resolve() } })
      signal.addEventListener('abort', off)
    }),
  }
}

function memoryCheck() {
  return {
    id: 'memory', label: '记忆模块', code: 'memory',
    wait: async (signal) => {
      const response = await fetch('/chengmeng-memory/status', { credentials: 'same-origin', cache: 'no-store', signal })
      if (!response.ok || !memoryStatusReady(await response.json())) throw new Error('Memory status unavailable')
    },
  }
}

function interfaceCheck() {
  return {
    id: 'ui', label: '对话界面', code: 'interface',
    wait: (signal) => new Promise((resolve) => {
      const found = () => document.querySelector('[data-composer-card]') !== null
      if (found()) return resolve()
      const observer = new MutationObserver(() => { if (found()) { observer.disconnect(); resolve() } })
      observer.observe(document.body, { childList: true, subtree: true })
      signal.addEventListener('abort', () => observer.disconnect())
    }),
  }
}

/** 对齐壁纸玻璃条：有就用它们的真实位置，这样玻璃条揭开时和壁纸的竖线对齐。没有就返回 null。 */
function wallpaperSlats(host) {
  const flutes = Array.from(document.querySelectorAll('.cm-wp__flute'))
  if (flutes.length < 3) return null
  const origin = host.getBoundingClientRect()
  return flutes.map((flute) => {
    const box = flute.getBoundingClientRect()
    return { left: box.left - origin.left, width: box.width }
  })
}

function StartupOverlay(props) {
  const React = require('react')
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    const host = ref.current
    if (!host || window.__chengmengStartupPlayed === true) return undefined
    const diag = window.__cmStartupDiag
    if (diag) diag.mountedAt = performance.now()
    let yielding = null // 先声明：onDone 里要用，不依赖调用时序
    const controller = mountStartup(host, {
      checks: props.checks,
      name: agentDisplayName(),
      version: window.__DSH_BOOT__ && window.__DSH_BOOT__.release && window.__DSH_BOOT__.release.version,
      slats: wallpaperSlats(host),
      onDone: (result) => {
        window.__chengmengStartupPlayed = true
        if (window.__cmStartupDiag) window.__cmStartupDiag.result = result
        if (yielding) yielding.disconnect()
      },
    })

    // 对话框一出现，动画就让路：DSH 首次启动时会弹出"预览版说明"、"开始使用"这类模态对话框，
    // 它们渲染在最上层，遮罩还会把下面的动画磨砂掉。用户这时要操作对话框，动画不该和它竞争。
    // 这里只看 role=dialog / alertdialog；本模块自己的覆盖层是 role=status，不会触发。
    const dialogOpen = () => document.querySelector('[role="dialog"],[role="alertdialog"]') !== null
    yielding = new MutationObserver(() => { if (dialogOpen()) controller.skip() })
    yielding.observe(document.body, { childList: true, subtree: true })
    if (dialogOpen()) controller.skip()

    return () => { if (yielding) yielding.disconnect(); controller.dispose() }
  }, [])
  return React.createElement('div', { ref, className: 'cm-boot-host' })
}

function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  let storage = null
  try { storage = window.localStorage } catch { /* 隐私模式：按默认值处理 */ }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (!shouldPlay({
    disabledByUser: startupDisabled(storage),
    reducedMotion: reduced.matches,
    alreadyPlayed: window.__chengmengStartupPlayed === true,
  })) return

  // 诊断：只在 localStorage['chengmeng.startup.diag'] === '1' 时记录。用来实测覆盖层是否和工作界面同一次渲染出现。
  if (readSetting(storage, DIAG_KEY) === '1') {
    const diag = { applyAt: performance.now(), frameExistedAtApply: document.querySelector('[data-shell-bottom]') !== null, firstFrameSeenAt: null }
    window.__cmStartupDiag = diag
    if (!diag.frameExistedAtApply) {
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-shell-bottom]')) { diag.firstFrameSeenAt = performance.now(); observer.disconnect() }
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
  }

  const checks = [fontsCheck(), hostCheck(ctx), interfaceCheck()]
  if (hasMemoryModule(window.__DSH_BOOT__)) checks.push(memoryCheck())

  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-chengmeng-startup', '')
    style.textContent = startupCSS()
    document.head.appendChild(style)
    return () => style.remove()
  }, 'chengmeng startup: styles')

  // 官方覆盖层槽位：和工作界面同一次渲染提交出现，所以不会先闪出工作界面。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'chengmeng-startup',
    order: 1000,
    inject: () => ({ checks }),
  }, StartupOverlay))
}
