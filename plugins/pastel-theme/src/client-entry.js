// DSH 客户端入口。构建时会被拼接在 springs.js、refraction.js、glass.js 之后，包进
// window.__ModuleLoader__.load 的 factory 里，所以可以直接使用它们的顶层符号。
// `require` 由模块加载器传入，只用来取宿主自带的 react。

const name = '@chengmeng/dsh-pastel-theme'
const inject = ['theme', 'slots']

const TOKEN_SOURCE = '@chengmeng/dsh-pastel-theme'
// Pastel 只有浅色（项目所有者 2026-11-10 决定取消深色模式）。开启时注册一个 colorScheme 为 light 的主题并切换过去：
// 第三方主题 id 只在当前进程生效，不会写进 DSH 的设置文件；关闭 Pastel 时恢复用户自己的外观偏好。
const PASTEL_THEME = 'chengmeng-pastel'
// MVP：开关先存在本机浏览器里（只影响外观，不触及 Agent、会话和记忆）。
// 后续 Phase 4 会改为写入 Host 设置并提供设置页入口。
const STORAGE_KEY = 'chengmeng.appearance.pastel'
const GLASS_KEY = 'chengmeng.appearance.glass' // off | standard | rich，留空表示自动

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

const pastelEnabled = () => readStorage(STORAGE_KEY) !== 'off'
const media = (query) => typeof window !== 'undefined' && window.matchMedia(query).matches

function currentGlassTier() {
  return chooseGlassTier({
    override: readStorage(GLASS_KEY),
    reducedTransparency: media('(prefers-reduced-transparency: reduce)'),
    highContrast: media('(prefers-contrast: more)'),
    forcedColors: media('(forced-colors: active)'),
    chromium: Boolean(globalThis.navigator?.userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand)))
      || /Chrome\//.test(globalThis.navigator?.userAgent ?? ''),
  })
}

// 透镜组件订阅的极简外部状态：Pastel 是否开启、玻璃档位。
const lensState = { snapshot: { on: false, tier: 'off' }, listeners: new Set() }
function setLens(next) {
  const prev = lensState.snapshot
  if (prev.on === next.on && prev.tier === next.tier) return
  lensState.snapshot = next
  for (const listener of lensState.listeners) listener()
}

let lensCounter = 0

/** 为 Rich 档创建一个只属于本实例的 SVG 位移滤镜，返回 { url, resize, dispose }。 */
function createLensFilter(doc) {
  const ns = 'http://www.w3.org/2000/svg'
  const id = `cm-liquid-${++lensCounter}`
  const svg = doc.createElementNS(ns, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  const filter = doc.createElementNS(ns, 'filter')
  filter.id = id
  for (const [k, v] of Object.entries({ filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', x: '0', y: '0', 'color-interpolation-filters': 'sRGB' })) filter.setAttribute(k, v)
  const image = doc.createElementNS(ns, 'feImage')
  for (const [k, v] of Object.entries({ x: '0', y: '0', preserveAspectRatio: 'none', result: 'map' })) image.setAttribute(k, v)
  const displace = doc.createElementNS(ns, 'feDisplacementMap')
  for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'map', scale: String(LENS_SCALE), xChannelSelector: 'R', yChannelSelector: 'G' })) displace.setAttribute(k, v)
  filter.append(image, displace)
  svg.appendChild(filter)
  doc.body.appendChild(svg)
  let size = ''
  return {
    url: `url(#${id})`,
    resize(width, height, radius) {
      const key = `${width}x${height}x${radius}`
      if (key === size || width < 2 || height < 2) return
      size = key
      for (const el of [filter, image]) {
        el.setAttribute('width', String(width))
        el.setAttribute('height', String(height))
      }
      image.setAttribute('href', displacementMapURL(doc, width, height, radius))
    },
    dispose() { svg.remove() },
  }
}

/**
 * 输入框透镜：玻璃本体加边缘流光，挂在官方槽位 conversation.input.overlay 里，跟随卡片尺寸。
 * 高光跟随指针（follow 弹簧），离开后回到左上方的静止位置；减少动态效果时高光不跟随。
 */
function ComposerLens() {
  const React = require('react')
  const { on, tier } = React.useSyncExternalStore(
    (listener) => { lensState.listeners.add(listener); return () => lensState.listeners.delete(listener) },
    () => lensState.snapshot,
  )
  const ref = React.useRef(null)

  React.useLayoutEffect(() => {
    const lens = ref.current
    const card = lens?.closest('[data-composer-card]')
    if (!lens || !card) return undefined
    const doc = lens.ownerDocument
    const win = doc.defaultView
    const filter = tier === 'rich' ? createLensFilter(doc) : null
    if (filter) lens.style.setProperty('--cm-glass-url', filter.url)

    let frame = 0
    const measure = () => {
      frame = 0
      const width = card.offsetWidth
      const height = card.offsetHeight
      lens.style.setProperty('--cm-ring-h', `${height}px`)
      filter?.resize(width, height, parseFloat(win.getComputedStyle(card).borderTopLeftRadius) || 28)
    }
    measure()
    const observer = new ResizeObserver(() => { if (!frame) frame = win.requestAnimationFrame(measure) })
    observer.observe(card)

    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
    const glass = lens.querySelector('.cm-glass')
    const rest = () => ({ x: card.offsetWidth * 0.28, y: card.offsetHeight * -0.12 })
    const sx = createSpringValue('follow', rest().x, (v) => glass?.style.setProperty('--cm-spec-x', `${v}px`))
    const sy = createSpringValue('follow', rest().y, (v) => glass?.style.setProperty('--cm-spec-y', `${v}px`))
    sx.jumpTo(rest().x)
    sy.jumpTo(rest().y)
    const aim = (x, y) => {
      if (reduced.matches) return
      sx.animateTo(x)
      sy.animateTo(y)
    }
    const onMove = (event) => {
      const box = card.getBoundingClientRect()
      aim(event.clientX - box.left, event.clientY - box.top)
    }
    const onLeave = () => { const r = rest(); aim(r.x, r.y) }
    card.addEventListener('pointermove', onMove)
    card.addEventListener('pointerleave', onLeave)

    return () => {
      observer.disconnect()
      if (frame) win.cancelAnimationFrame(frame)
      card.removeEventListener('pointermove', onMove)
      card.removeEventListener('pointerleave', onLeave)
      sx.stop()
      sy.stop()
      filter?.dispose()
    }
  }, [on, tier])

  if (!on) return null
  return React.createElement('div', { ref, className: 'cm-lens', 'data-tier': tier, 'aria-hidden': 'true' },
    tier === 'off' ? null : React.createElement('div', { className: 'cm-glass' }),
    React.createElement('div', { className: 'cm-ring' }),
  )
}

/**
 * 思考强度控件的 React 外壳：订阅 DSH 官方 modelDirectories 的 store，把当前模型的档位交给
 * 原生 DOM 组件 mountEffortControl；提交走 directory.select，和 DSH 自己的模型菜单同一条路径。
 * 当前模型没有 reasoning 元数据时，控件隐藏。
 */
function EffortControl(props) {
  const React = require('react')
  const { directory, select, load, available } = props
  const subscribe = React.useCallback((fn) => directory.subscribe(fn), [directory])
  const getSnapshot = React.useCallback(() => directory.getSnapshot(), [directory])
  const state = React.useSyncExternalStore(subscribe, getSnapshot)
  const hostRef = React.useRef(null)
  const control = React.useRef(null)
  const latest = React.useRef(null)
  latest.current = resolveReasoning(state)

  React.useLayoutEffect(() => {
    if (!hostRef.current) return undefined
    control.current = mountEffortControl(hostRef.current, {
      label: '思考强度',
      resetLabel: '恢复默认',
      scheme: () => (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'),
      onSelect: async (effortId) => {
        const info = latest.current
        if (!info) return
        const result = await select({ provider: info.provider, model: info.model, reasoningEffort: effortId })
        if (result && result.ok === false) throw result.error
      },
    })
    load?.()
    return () => {
      control.current?.dispose()
      control.current = null
    }
  }, [directory])

  React.useLayoutEffect(() => {
    control.current?.update(available === false ? null : latest.current)
  }, [state, available])

  return React.createElement('span', { ref: hostRef, className: 'cm-effort-host' })
}

/** 侧栏宽度：DSH 写在窗口框架的 grid-template-columns 内联样式里。这里只读，不改。 */
function observeSidebarWidth(doc, onWidth) {
  let observer = null
  let attempts = 0
  let timer = 0
  const attach = () => {
    const frame = doc.querySelector('[data-shell-bottom]')?.parentElement
    if (!frame) {
      if (attempts++ < 40) timer = setTimeout(attach, 250)
      return
    }
    const read = () => onWidth(parseFloat(frame.style.gridTemplateColumns))
    read()
    observer = new MutationObserver(read)
    observer.observe(frame, { attributes: true, attributeFilter: ['style'] })
  }
  attach()
  return () => { clearTimeout(timer); observer?.disconnect() }
}

function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  // Keep the native sidebar toggle and composer, but remove the owner's marked
  // brand/marketing chrome. Slot markers avoid depending on hashed CSS names.
  const React = require('react')
  for (const slot of ['sidebar.brand.mark', 'sidebar.brand.name']) {
    ctx.slots.inject(slot, () => ctx.slots.register({ name: slot },
      () => React.createElement('span', { 'data-chengmeng-hide-brand': '', hidden: true })))
  }
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
    { name: 'conversation.hero.brand.mark' },
    () => React.createElement('span', { 'data-chengmeng-hide-hero': '', hidden: true })))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-chengmeng-clean-home', '')
    style.textContent = `
      div:has(> span [data-chengmeng-hide-hero]) { display: none !important; }
      [data-window-drag]:has(> [data-sidebar-toggle]) > :not([data-sidebar-toggle]) { display: none !important; }
      [data-windows-titlebar] [data-window-drag]:has(> [data-sidebar-toggle]) { height: 20px !important; min-height: 0 !important; }
      [data-window-drag] > :is(button,span):not([data-sidebar-toggle]):has([data-chengmeng-hide-brand]) { display: none !important; }
      [data-sidebar-toggle] > span[aria-hidden="true"] { display: none !important; }
      [data-sidebar-toggle] > svg { display: inline !important; }
    `
    document.head.appendChild(style)
    return () => style.remove()
  }, 'chengmeng: uncluttered home and functional sidebar toggle')

  const desktop = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`)
  const scheme = () => (ctx.theme.getTheme().active.colorScheme === 'dark' ? 'dark' : 'light')

  let wallpaper = null
  let releaseTokens = null
  let lensStyle = null
  let stopSidebar = null
  let sideWidth = 280
  let releaseTheme = null
  let userPreference = null

  const pinLight = () => {
    if (releaseTheme) return
    userPreference = ctx.theme.getTheme().preference
    const unregister = ctx.theme.register({ id: PASTEL_THEME, colorScheme: 'light', tokens: {} })
    ctx.theme.setTheme(PASTEL_THEME)
    releaseTheme = () => {
      // 先取出要恢复的偏好：注销主题会同步触发 theme/change，DSH 会把偏好临时重置为默认值。
      const restore = userPreference
      unregister()
      if (restore && restore !== PASTEL_THEME) {
        try { ctx.theme.setTheme(restore) } catch { /* 偏好已失效时保持 DSH 默认 */ }
      }
    }
  }
  const unpinLight = () => {
    // 先清空句柄，theme/change 处理器看到 releaseTheme 为空就不会再把外观拉回 Pastel。
    const release = releaseTheme
    releaseTheme = null
    release?.()
  }

  const teardown = () => {
    unpinLight()
    stopSidebar?.()
    stopSidebar = null
    wallpaper?.dispose()
    wallpaper = null
    releaseTokens?.()
    releaseTokens = null
    lensStyle?.remove()
    lensStyle = null
    setLens({ on: false, tier: 'off' })
  }

  // token 只在"开关或桌面断点"变化时重写。不能在 theme/change 里重写，
  // 因为 overrideTokens 本身就会触发 theme/change，那样会形成死循环。
  const sync = () => {
    const enabled = pastelEnabled()
    const showWallpaper = enabled && desktop.matches

    if (enabled) pinLight()
    else unpinLight()

    if (showWallpaper && !wallpaper) {
      wallpaper = mountWallpaper(document, { scheme: scheme() })
      wallpaper.setSideWidth(sideWidth)
      stopSidebar = observeSidebarWidth(document, (px) => {
        if (Number.isFinite(px)) sideWidth = px
        wallpaper?.setSideWidth(sideWidth)
      })
    }
    if (!showWallpaper && wallpaper) {
      stopSidebar?.()
      stopSidebar = null
      wallpaper.dispose()
      wallpaper = null
    }

    if (enabled && !lensStyle) {
      lensStyle = document.createElement('style')
      lensStyle.setAttribute('data-chengmeng-lens', '')
      lensStyle.textContent = lensCSS(springCSSVariables())
      document.head.appendChild(lensStyle)
    }
    if (!enabled && lensStyle) {
      lensStyle.remove()
      lensStyle = null
    }
    setLens({ on: enabled, tier: enabled ? currentGlassTier() : 'off' })

    releaseTokens?.()
    releaseTokens = enabled ? ctx.theme.overrideTokens(TOKEN_SOURCE, pastelTokens({ wallpaper: showWallpaper })) : null
  }

  const safeSync = () => {
    try {
      sync()
    } catch (error) {
      // 外观出任何问题都不能影响正常使用：回退到 DSH 原生外观。
      console.warn('[chengmeng] Pastel 外观加载失败，已回退到默认外观', error)
      teardown()
    }
  }

  const watched = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)']
    .map((query) => window.matchMedia(query))

  ctx.effect(() => {
    safeSync()
    desktop.addEventListener('change', safeSync)
    for (const query of watched) query.addEventListener('change', safeSync)
    const onStorage = (event) => { if (event.key === STORAGE_KEY || event.key === GLASS_KEY) safeSync() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('chengmeng-appearance-change', safeSync)
    return () => {
      desktop.removeEventListener('change', safeSync)
      for (const query of watched) query.removeEventListener('change', safeSync)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('chengmeng-appearance-change', safeSync)
      teardown()
    }
  }, 'chengmeng pastel: wallpaper, tokens and composer lens')

  // 外观偏好被改走时（DSH 异步读入已保存的偏好，或者用户在设置里点了浅色/深色/跟随系统），
  // 记下它作为关闭 Pastel 后要恢复的偏好，然后把外观拉回 Pastel 浅色。
  ctx.on('theme/change', (snapshot) => {
    if (!releaseTheme || snapshot.preference === PASTEL_THEME) return
    userPreference = snapshot.preference
    queueMicrotask(() => {
      if (releaseTheme && ctx.theme.getTheme().preference !== PASTEL_THEME) ctx.theme.setTheme(PASTEL_THEME)
    })
  })

  // 官方槽位：等 ui-conversation 声明 conversation.input.overlay 之后再注册。
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'chengmeng-composer-lens',
    order: -100,
  }, ComposerLens))

  // 思考强度滑动条：功能控件，不随 Pastel 开关隐藏。只有 modelDirectories 服务在场时才注册，
  // 所以模型选择插件缺席时它只是不出现，不会拖住本插件的其他部分。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-chengmeng-effort', '')
    style.textContent = `.cm-effort-chip,.cm-effort-pop{${springCSSVariables()}}${effortCSS()}`
    document.head.appendChild(style)
    return () => style.remove()
  }, 'chengmeng: effort slider styles')

  ctx.inject(['modelDirectories', 'sessions'], (scope) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'chengmeng-effort',
      order: -10,
      inject: (sessionId) => {
        const directory = models.directoryFor(sessionId)
        const available = sessions.subagentAddress?.(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => { if (available) directory.load().catch(() => { /* 错误由 store 呈现 */ }) },
          select: (selection) => (available ? directory.select(selection) : Promise.resolve(undefined)),
        }
      },
    }, EffortControl))
  })
}
