/**
 * Pastel「折光」壁纸。
 *
 * 一条粉、白、蓝循环的竖向色带，隔着一排竖向棱镜玻璃观看：每根玻璃条里是同一条色带，
 * 只是相位不同，越往右越靠上，所以相邻两条交界处颜色会"跳"一下，整体呈斜向推进。
 *
 * 本文件只包含纯函数和一个 DOM 挂载函数，不依赖 DSH：
 * 预览页、单元测试和 DSH 客户端插件共用同一份实现。
 * 构建脚本会把它内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`。
 */

/** 从参考图取样后整理出的色板。 */
export const PALETTE = Object.freeze({
  cyan: '#1CCBFC',
  sky: '#7FD6F5',
  ice: '#DCEEF8',
  paper: '#FAF6F5',
  blush: '#FDDDE3',
  pink: '#FBA8B8',
  rose: '#F88AA2',
  lilac: '#C3BDDB',
  ink: '#1E2433',
})

/** 壁纸只在桌面端显示（ADR-004）：窗口宽度小于这个值时不挂载。 */
export const DESKTOP_MIN_WIDTH = 1024

/**
 * 色场相对视口的几何参数：上移 100%，总高 300%，保证错位加漂移后仍然铺满。
 * 色带一个循环占色场高度的 40%，约等于 1.2 个屏幕高。
 */
export const FIELD_TOP = 100
export const FIELD_HEIGHT = 300
export const CYCLE = 40
export const DRIFT = 2

/** 每根玻璃条的目标宽度约 180px，数量在 6 到 12 之间。窄屏返回 0，表示不显示壁纸。 */
export function fluteCount(width) {
  if (!Number.isFinite(width) || width < DESKTOP_MIN_WIDTH) return 0
  return Math.max(6, Math.min(12, Math.round(width / 180)))
}

/**
 * 每根玻璃条的纵向错位，单位是色场高度的百分比。
 * 从左到右整体上移约 0.6 个循环，形成参考图里斜向推进的相位；
 * 再叠一点正弦扰动，避免看起来机械。结果是确定的，同样的 n 永远得到同样的结果。
 */
export function fluteOffsets(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0
    out.push(Math.round((-0.6 * CYCLE * t + 3 * Math.sin(i * 2.1)) * 100) / 100)
  }
  return out
}

/**
 * 一个循环内的色带，位置以"循环的百分比"填写。数据来自参考图逐列取样。
 * 玫瑰色直接过渡到青色、不经过白色：在 OKLCH 空间里会自然经过淡紫（参考图里的 #C3B9DB），而不是发灰。
 */
export const CYCLE_LIGHT = Object.freeze([
  [0, '#12C4FD'], [10, '#1CCBFC'], [22, '#7FD6F5'], [34, '#E4EEF6'], [44, '#FAF4F4'],
  [54, '#FDD3DC'], [66, '#FBA8B8'], [76, '#FA8EA6'], [100, '#12C4FD'],
])

/**
 * Pastel 只有浅色一种（项目所有者 2026-11-10 决定取消深色模式）。
 * 之前的深色色带把暗玫瑰和暗青放在一起，在 OKLCH 里过渡会经过紫色，整体发紫，所以删掉了。
 */
export function fieldBackground() {
  const stops = CYCLE_LIGHT.map(([at, color]) => `${color} ${Math.round(at * CYCLE) / 100}%`).join(', ')
  return `repeating-linear-gradient(180deg in oklch, ${stops})`
}

/** 壁纸样式表。由插件自己持有，卸载时一并移除。 */
export function wallpaperCSS() {
  return `
.cm-wp{position:fixed;inset:0;z-index:-1;display:flex;overflow:hidden;pointer-events:none;contain:strict;background:var(--cm-wp-base)}
.cm-wp{--cm-side-w:280px;--cm-frost-fade:96px}
.cm-wp__frost{position:absolute;top:0;bottom:0;left:0;width:calc(var(--cm-side-w) + var(--cm-frost-fade));-webkit-backdrop-filter:blur(22px) saturate(1.15);backdrop-filter:blur(22px) saturate(1.15);background:var(--cm-frost);-webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 2 * var(--cm-frost-fade)),transparent);mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 2 * var(--cm-frost-fade)),transparent)}
.cm-wp{--cm-frost:rgb(250 246 245 / .52);--cm-wp-base:#F4F1F3;--cm-wp-veil:radial-gradient(ellipse 36% 80% at 58% 50%,rgb(250 246 245 / .58),rgb(250 246 245 / .12));--cm-wp-edge:rgb(255 255 255 / .5);--cm-wp-shade:rgb(40 52 96 / .06);--cm-wp-sheen:rgb(255 255 255 / .26)}
.cm-wp__flute{position:relative;flex:1 1 0;min-width:0;overflow:hidden}
.cm-wp__flute+.cm-wp__flute{box-shadow:inset 1px 0 0 var(--cm-wp-edge)}
.cm-wp__field{position:absolute;left:0;right:0;top:-${FIELD_TOP}%;height:${FIELD_HEIGHT}%;background:var(--cm-wp-field);transform:translateY(var(--dy));will-change:translate;animation:cm-wp-drift 120s ease-in-out infinite alternate}
.cm-wp__flute::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,var(--cm-wp-sheen),transparent 34%,transparent 66%,var(--cm-wp-shade))}
.cm-wp__veil{position:absolute;inset:0;background:var(--cm-wp-veil)}
@keyframes cm-wp-drift{from{translate:0 -${DRIFT}%}to{translate:0 ${DRIFT}%}}
@media (prefers-reduced-motion:reduce){.cm-wp__field{animation:none}}
@media (max-width:${DESKTOP_MIN_WIDTH - 0.02}px){.cm-wp{display:none}}
`
}

/**
 * Pastel 的 token 覆盖层，交给 `ctx.theme.overrideTokens` 使用，深浅两种模式都必须给值。
 * 壁纸显示时，基础背景必须在 body 上整体透明（这个 token 是继承的）。侧栏也改成透明，
 * 由壁纸层里的磨砂区来托底：磨砂在侧栏右边缘之后平滑淡出，所以侧栏和壁纸之间没有硬边。
 * 窄屏不显示壁纸时，只换成 Pastel 的纯色底。
 */
export function pastelTokens({ wallpaper }) {
  // Pastel 只有浅色：深色值与浅色相同（API 要求两个值都给）。
  const both = (value) => ({ light: value, dark: value })
  if (wallpaper) {
    return {
      '--dsw-alias-bg-base': both('transparent'),
      '--dsw-specific-sidebar-fill': both('transparent'),
      ...surfaceTokens(true),
    }
  }
  return {
    '--dsw-alias-bg-base': both(PALETTE.paper),
    '--dsw-specific-sidebar-fill': both('#F5EDF0'),
    ...surfaceTokens(false),
  }
}

/**
 * 其他页面的统一：设置面板和卡片（bg-layer-2）、浮起表面（bg-layer-1）、浮层（bg-overlay）、
 * 菜单、导航选中项和模态遮罩，都换成 Pastel 的纸白玻璃。
 * 有壁纸时是半透明的：DSH 的模态遮罩自带背景模糊，面板下面透出的是柔化后的粉白蓝；
 * 遮罩本身从黑色改为浅色的纸白，不把折光压暗。没有壁纸（窄屏）时用不透明的纸白。
 */
export function surfaceTokens(glass) {
  const both = (value) => ({ light: value, dark: value })
  if (glass) {
    return {
      '--dsw-alias-bg-layer-2': both('rgb(252 249 250 / .8)'),
      '--dsw-alias-bg-layer-1': both('rgb(255 255 255 / .74)'),
      '--dsw-alias-bg-overlay': both('rgb(250 247 249 / .9)'),
      '--dsw-alias-bg-mask-1': both('rgb(244 238 244 / .42)'),
      // DSH 的模态遮罩在浅色下默认不模糊；半透明面板后面会透出对话内容，所以让遮罩把背后磨砂化。
      '--dsw-mask-blur': both('blur(18px) saturate(1.15)'),
      '--dsw-specific-menu': both('rgb(252 250 251 / .8)'),
      '--dsw-specific-sidebar-nav-item-active': both('rgb(255 255 255 / .66)'),
    }
  }
  return {
    '--dsw-alias-bg-layer-2': both('#FBF8F9'),
    '--dsw-alias-bg-layer-1': both('#FFFFFF'),
    '--dsw-alias-bg-overlay': both('#F7F3F5'),
    '--dsw-alias-bg-mask-1': both('rgb(30 36 51 / .2)'),
    '--dsw-specific-sidebar-nav-item-active': both('#F1E9EE'),
  }
}

/**
 * 把壁纸挂到 document.body 底层，返回 { element, update, dispose }。
 * 挂载内容只有一个 <style> 和一个 aria-hidden 的 <div>，不会碰 DSH 自己的任何节点。
 */
export function mountWallpaper(doc, { scheme = 'light' } = {}) {
  const win = doc.defaultView
  const style = doc.createElement('style')
  style.setAttribute('data-chengmeng-wallpaper', '')
  style.textContent = wallpaperCSS()
  doc.head.appendChild(style)

  const root = doc.createElement('div')
  root.className = 'cm-wp'
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('data-chengmeng-wallpaper', '')
  doc.body.prepend(root)

  let current = { scheme: null, n: -1 }
  let frame = 0

  const render = (next) => {
    const n = fluteCount(win ? win.innerWidth : DESKTOP_MIN_WIDTH)
    if (next.scheme !== current.scheme) {
      root.dataset.scheme = next.scheme
      root.style.setProperty('--cm-wp-field', fieldBackground(next.scheme))
    }
    if (n !== current.n) {
      const offsets = fluteOffsets(n)
      root.replaceChildren(
        ...offsets.map((dy, i) => {
          const flute = doc.createElement('div')
          flute.className = 'cm-wp__flute'
          const field = doc.createElement('div')
          field.className = 'cm-wp__field'
          field.style.setProperty('--dy', `${dy}%`)
          flute.appendChild(field)
          return flute
        }),
        Object.assign(doc.createElement('div'), { className: 'cm-wp__frost' }),
        Object.assign(doc.createElement('div'), { className: 'cm-wp__veil' }),
      )
    }
    current = { scheme: next.scheme, n }
  }

  const onResize = () => {
    if (frame) return
    frame = win.requestAnimationFrame(() => {
      frame = 0
      render(current)
    })
  }

  render({ scheme })
  win?.addEventListener('resize', onResize)

  return {
    element: root,
    update(next) { render({ ...current, ...next }) },
    /** 侧栏宽度变化时调用：磨砂层的范围和渐变位置跟着侧栏走。 */
    setSideWidth(px) {
      if (Number.isFinite(px) && px >= 0) root.style.setProperty('--cm-side-w', `${Math.round(px)}px`)
    },
    dispose() {
      win?.removeEventListener('resize', onResize)
      if (frame) win.cancelAnimationFrame(frame)
      root.remove()
      style.remove()
    },
  }
}
