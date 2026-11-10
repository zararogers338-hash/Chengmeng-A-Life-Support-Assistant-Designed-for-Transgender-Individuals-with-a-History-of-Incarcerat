/**
 * 思考强度滑动条。
 *
 * 档位来自当前模型的 reasoning 元数据（DSH 的 ModelReasoning：efforts 加 defaultEffort），
 * 提交走 DSH 官方的 modelDirectories 服务，和 DSH 自己的模型菜单是同一条路径。
 * 本文件只包含纯函数和一个不依赖 React 的 DOM 组件，所以预览页可以用模拟数据直接驱动它。
 *
 * 物理（来自 liquid-glass-motion Skill）：
 * - 拖动时滑块用 follow 弹簧追随手指；拖出两端走橡皮筋，上限 0.3 格。
 * - 松手后按"手指位置 + 速度 × 0.1 秒"投射落点，最多越过一格，再用 travel 弹簧落位（速度接力）。
 * - 滑块是 chrome：按下时用 press 弹簧膨胀，移动时按速度横向拉伸。轨道和文字保持安静。
 * - 透明度和颜色只用 fade。减少动态效果时直接到位，不膨胀也不拉伸。
 *
 * 构建脚本会把本文件内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`，
 * 以及指向 src 内其他模块的相对 import（构建时剥掉）。
 */
import { createSpringValue } from './springs.js'

export const EFFORT_THUMB = 40
export const EFFORT_TRACK_H = 40

/** Skill 的橡皮筋：边缘斜率 0.55，越拉越硬，永远不超过 limit。 */
export function rubberBand(x, limit) {
  if (limit <= 0) return 0
  return limit * (1 - 1 / ((Math.abs(x) * 0.55) / limit + 1)) * Math.sign(x)
}

/** 区间内原样返回，越界部分走橡皮筋。 */
export function band(x, min, max, limit) {
  if (x < min) return min + rubberBand(x - min, limit)
  if (x > max) return max + rubberBand(x - max, limit)
  return x
}

/**
 * n 个档位在轨道上的中心位置（像素）。两端正好留出半个滑块：
 * 滑块到端点时和轨道的圆头完全重合，不会超出轨道，也不会在旁边露出一截轨道。
 */
export function stopPositions(n, trackWidth, thumb = EFFORT_THUMB) {
  const inset = thumb / 2
  if (n <= 1) return [trackWidth / 2]
  const span = Math.max(0, trackWidth - inset * 2)
  return Array.from({ length: n }, (_, i) => inset + (span * i) / (n - 1))
}

/** 填充的右端相对滑块中心的距离：比滑块半径少 3px，圆头完全藏在滑块后面。 */
export function fillReach(thumb = EFFORT_THUMB) {
  return thumb / 2 - 3
}

export function nearestStop(positions, x) {
  let best = 0
  for (let i = 1; i < positions.length; i++) if (Math.abs(positions[i] - x) < Math.abs(positions[best] - x)) best = i
  return best
}

/**
 * 松手决定落点：看手指，不看弹簧（Skill 规律 3）。
 * 投射 = 手指位置 + 速度 × 0.1 秒；结果最多比手指所在的档位多走一格。
 */
export function projectStop(positions, target, velocity) {
  const here = nearestStop(positions, target)
  const projected = nearestStop(positions, target + velocity * 0.1)
  return Math.max(0, Math.min(positions.length - 1, Math.max(here - 1, Math.min(here + 1, projected))))
}

/**
 * 从 DSH 模型目录的快照里取出当前模型的思考档位。
 * 没有选择模型、模型不在目录里或模型没有 reasoning 元数据时返回 null，滑动条随之隐藏。
 */
export function resolveReasoning(state) {
  const current = state?.current
  if (!current) return null
  const group = state.groups?.find((g) => g.id === current.provider)
  const model = group?.models?.find((m) => m.id === current.model)
  const efforts = model?.reasoning?.efforts ?? []
  if (efforts.length < 2) return null
  const defaultEffort = model.reasoning.defaultEffort ?? efforts[0].id
  const selected = state.pending?.reasoningEffort ?? current.reasoningEffort ?? defaultEffort
  const index = Math.max(0, efforts.findIndex((e) => e.id === selected))
  return {
    provider: current.provider,
    model: current.model,
    modelName: model.name,
    efforts,
    defaultEffort,
    index,
    pending: state.status === 'selecting',
  }
}

/** "关闭思考"一类的档位：没有光，所以竖条全暗、标题用中性灰。 */
export const OFF_EFFORTS = Object.freeze(['off', 'none', 'disabled'])
export const isOffEffort = (effort) => OFF_EFFORTS.includes(String(effort?.id ?? '').toLowerCase())

/**
 * 档位的三种光（配色按项目所有者 2026-11-10 提供的参考图）：
 * - off：没有光，中性灰，轨道不填充；
 * - on：最高档以下的所有档位，一律蓝色实心；
 * - max：最高档，紫色渐变，填充里的粒子向后流动。
 */
export function effortTier(index, efforts) {
  if (isOffEffort(efforts[index])) return 'off'
  return index === efforts.length - 1 ? 'max' : 'on'
}

/** 标题、强度竖条和选中标签用的文字色。都能放在对应的玻璃底上阅读。 */
export const EFFORT_TINTS = Object.freeze({
  light: Object.freeze({ off: '#6B7088', on: '#2F6FE8', max: '#8B5CF6' }),
  dark: Object.freeze({ off: '#A3A8BD', on: '#5B93F7', max: '#A98BFF' }),
})

export function effortTint(tier, scheme = 'light') {
  const palette = EFFORT_TINTS[scheme] ?? EFFORT_TINTS.light
  return palette[tier] ?? palette.on
}

/**
 * 粒子：填充区里的小亮点。用确定的伪随机种子，同样的宽高永远得到同样的分布。
 * 返回 [{ x, y, r, a, v }]，v 是向左流动的速度（像素每秒）。
 */
export function seedSparks(count, width, height, seed = 7) {
  let s = seed >>> 0 || 1
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  return Array.from({ length: count }, () => ({
    x: rand() * width,
    y: 5 + rand() * Math.max(1, height - 10),
    r: 0.7 + rand() * 1.2,
    a: 0.35 + rand() * 0.55,
    v: SPARK_MIN_SPEED + rand() * (SPARK_MAX_SPEED - SPARK_MIN_SPEED),
  }))
}

/** 粒子流速（像素每秒）：项目所有者要求"足够快"，大约 1 秒内划过整条轨道。 */
export const SPARK_MIN_SPEED = 160
export const SPARK_MAX_SPEED = 360
/** 拖尾长度与速度成正比：相当于粒子在 35 毫秒里走过的距离。 */
export const SPARK_TRAIL = 0.035

/**
 * 推进粒子流：每颗粒子按自己的速度向左（向后）移动；流出左端后从右端重新进入，
 * 纵向位置换一个新的值，避免看出循环。原地修改并返回同一个数组。
 */
export function stepSparks(sparks, dt, width, height, rand = Math.random) {
  for (const p of sparks) {
    p.x -= p.v * dt
    if (p.x < -4) {
      p.x = width + rand() * 60
      p.y = 5 + rand() * Math.max(1, height - 10)
    }
  }
  return sparks
}

/**
 * 粒子画布控制器。mode：'none' 不画；'still' 画一帧静止的粒子；'flow' 逐帧向后流动。
 * 减少动态效果时，'flow' 降级为 'still'。离开 'flow' 后立即停止帧回调。
 */
export function createSparkField(canvas, reducedMotion) {
  const win = canvas.ownerDocument.defaultView
  const ctx = canvas.getContext('2d')
  let width = 0
  let height = 0
  let sparks = []
  let mode = 'none'
  let frame = 0
  let last = 0

  const draw = () => {
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    if (mode === 'none') return
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    for (const p of sparks) {
      const fadeIn = Math.min(1, Math.max(0, p.x / 24))
      // 流动时画一条向后（右侧）的拖尾，长度随速度变化；静止时只画亮点。
      if (mode === 'flow') {
        ctx.globalAlpha = p.a * fadeIn * 0.35
        ctx.lineWidth = p.r * 1.4
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x + p.v * SPARK_TRAIL, p.y)
        ctx.stroke()
      }
      ctx.globalAlpha = p.a * fadeIn
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
  const tick = (now) => {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
    last = now
    stepSparks(sparks, dt, width, height)
    draw()
    frame = win.requestAnimationFrame(tick)
  }
  const stop = () => {
    if (frame) win.cancelAnimationFrame(frame)
    frame = 0
    last = 0
  }

  return {
    resize(w, h) {
      const dpr = win.devicePixelRatio || 1
      width = Math.max(1, Math.round(w))
      height = Math.max(1, Math.round(h))
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      sparks = seedSparks(Math.round(width / 9), width, height)
      draw()
    },
    setMode(next) {
      const effective = next === 'flow' && reducedMotion?.matches ? 'still' : next
      if (effective === mode) return
      mode = effective
      if (mode === 'flow') { if (!frame) frame = win.requestAnimationFrame(tick) } else { stop(); draw() }
    },
    get mode() { return mode },
    dispose() { stop() },
  }
}

export function effortCSS() {
  const fade = 'var(--cm-spring-fade-ms) var(--cm-spring-fade)'
  const push = 'var(--cm-spring-push-ms) var(--cm-spring-push)'
  const press = 'var(--cm-spring-press-ms) var(--cm-spring-press)'
  return `
.cm-effort-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 8px;border:0;border-radius:999px;background:rgb(128 134 150 / .12);color:var(--dsw-alias-label-secondary,#4A5068);font:inherit;font-size:12px;cursor:pointer;transition:background-color ${fade}}
.cm-effort-chip[hidden]{display:none}
.cm-effort-chip:hover{background:rgb(128 134 150 / .2)}
.cm-effort-chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176E6);outline-offset:1px}
.cm-effort-chip[aria-expanded=true]{background:rgb(128 134 150 / .24)}
.cm-effort-glyph{display:inline-flex;align-items:flex-end;gap:2px;height:12px}
.cm-effort-glyph i{width:3px;border-radius:2px;background:currentColor;opacity:.28}
.cm-effort-glyph i[data-on]{opacity:1}
.cm-effort-pop{position:fixed;z-index:1000;width:304px;box-sizing:border-box;padding:14px 16px 16px;border-radius:24px;color:var(--dsw-alias-label-primary,#1E2433);
  background:rgb(246 244 248 / .74);-webkit-backdrop-filter:blur(24px) saturate(1.3);backdrop-filter:blur(24px) saturate(1.3);
  box-shadow:0 24px 48px -20px rgb(40 46 70 / .35),0 6px 16px -8px rgb(40 46 70 / .16),inset 0 1px 0 rgb(255 255 255 / .9),inset 0 0 0 1px rgb(255 255 255 / .45);
  opacity:0;transform:translateY(8px) scale(.98);transform-origin:50% 100%;transition:opacity ${fade},transform ${push}}
body[data-ds-dark-theme] .cm-effort-pop{background:rgb(22 25 40 / .78);box-shadow:0 24px 48px -20px rgb(0 0 0 / .6),inset 0 1px 0 rgb(255 255 255 / .12),inset 0 0 0 1px rgb(255 255 255 / .08)}
.cm-effort-pop[data-open]{opacity:1;transform:none}
.cm-effort-pop[data-closing]{opacity:0;transform:none}
.cm-effort-head{display:grid;grid-template-columns:28px 1fr 28px;align-items:center;gap:8px;margin-bottom:14px}
.cm-effort-head .cm-effort-glyph{height:16px;color:var(--cm-effort-tint)}
.cm-effort-head .cm-effort-glyph i{width:4px}
.cm-effort-title{text-align:center;line-height:1.25}
.cm-effort-name{display:block;font-size:20px;font-weight:600;color:var(--cm-effort-tint);transition:color ${fade}}
.cm-effort-model{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#5B6178);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-effort-reset{width:28px;height:28px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#5B6178);cursor:pointer;display:grid;place-items:center}
.cm-effort-reset[hidden]{display:grid;visibility:hidden}
.cm-effort-reset:hover{background:rgb(128 134 150 / .16)}
.cm-effort-reset:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176E6)}
.cm-effort-track{position:relative;height:${EFFORT_TRACK_H}px;border-radius:999px;touch-action:none;cursor:pointer;background:rgb(128 134 150 / .16);box-shadow:inset 0 1px 2px rgb(30 36 60 / .1)}
body[data-ds-dark-theme] .cm-effort-track{background:rgb(255 255 255 / .08);box-shadow:none}
.cm-effort-fill{position:absolute;left:0;top:0;bottom:0;width:var(--cm-fill,0px);border-radius:999px;overflow:hidden;pointer-events:none;transition:opacity ${fade}}
.cm-effort-fill>i{position:absolute;top:0;bottom:0;left:0;width:var(--cm-track-w,100%);transition:opacity ${fade}}
.cm-effort-fill>.cm-on{background:#3B82F6}
.cm-effort-fill>.cm-max{opacity:0;background:linear-gradient(90deg in oklch,#8E9CFF 0%,#B89DFF 30%,#8A57E2 66%,#6B50D6 100%)}
.cm-effort-pop[data-tier=max] .cm-effort-fill>.cm-max{opacity:1}
.cm-effort-pop[data-tier=off] .cm-effort-fill{opacity:0}
.cm-effort-sparks{position:absolute;top:0;left:0;pointer-events:none}
.cm-effort-tick{position:absolute;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgb(110 116 134 / .5);pointer-events:none;transition:opacity ${fade}}
body[data-ds-dark-theme] .cm-effort-tick{background:rgb(255 255 255 / .32)}
.cm-effort-tick[data-covered]{opacity:0}
.cm-effort-chip .cm-effort-glyph{color:var(--cm-effort-tint,currentColor)}
.cm-effort-thumb{position:absolute;top:50%;left:0;width:${EFFORT_THUMB}px;height:${EFFORT_THUMB}px;margin:${-EFFORT_THUMB / 2}px 0 0 ${-EFFORT_THUMB / 2}px;border-radius:50%;background:#fff;cursor:grab;
  box-shadow:0 4px 12px rgb(30 36 60 / .22),0 1px 2px rgb(30 36 60 / .2),inset 0 -2px 4px rgb(30 36 60 / .06);transform:translateX(var(--cm-x,0px)) scale(var(--cm-sx,1),var(--cm-sy,1))}
.cm-effort-thumb::after{content:"";position:absolute;inset:0;border-radius:inherit;transform:scale(var(--cm-press,1));transition:transform ${press};box-shadow:inherit;background:inherit}
.cm-effort-thumb[data-pressed]{--cm-press:1.12;cursor:grabbing}
.cm-effort-thumb:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176E6);outline-offset:2px}
.cm-effort-pop:focus{outline:none}
.cm-effort-labels{display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#5B6178)}
.cm-effort-labels span[data-on]{color:var(--cm-effort-tint);font-weight:600}
@media (prefers-reduced-motion:reduce){.cm-effort-pop{transform:none}.cm-effort-thumb::after{transition:none}.cm-effort-thumb[data-pressed]{--cm-press:1}}
`
}

const ns = 'http://www.w3.org/2000/svg'
const el = (doc, tag, cls, attrs = {}) => {
  const node = doc.createElement(tag)
  if (cls) node.className = cls
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}
function glyph(doc, level) {
  const box = el(doc, 'span', 'cm-effort-glyph', { 'aria-hidden': 'true' })
  for (let i = 0; i < 3; i++) {
    const bar = doc.createElement('i')
    bar.style.height = `${(i + 1) * 4}px`
    if (i < level) bar.setAttribute('data-on', '')
    box.appendChild(bar)
  }
  return box
}
function resetIcon(doc) {
  const svg = doc.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  const path = doc.createElementNS(ns, 'path')
  path.setAttribute('d', 'M4.5 10a5.5 5.5 0 1 0 1.7-4M4.5 3.5V7H8')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/**
 * 档位换算成亮起的竖条数：Off 一根不亮；其余档位在 1..3 根之间均匀分布。
 * efforts 是完整档位列表，index 是当前档位。
 */
export function glyphLevel(index, efforts) {
  const list = Array.isArray(efforts) ? efforts : Array.from({ length: efforts }, (_, i) => ({ id: String(i) }))
  if (isOffEffort(list[index])) return 0
  const lit = list.filter((e) => !isOffEffort(e))
  const pos = lit.indexOf(list[index])
  if (lit.length <= 1) return 3
  return 1 + Math.round((pos / (lit.length - 1)) * 2)
}

/**
 * 挂载思考强度控件：一个输入框里的小胶囊，点开后是浮起的玻璃面板和滑动条。
 * options: { label, resetLabel, onSelect(effortId) → Promise|void, scheme() → 'light'|'dark' }
 * 返回 { update(reasoning), dispose() }。reasoning 为 null 时整个控件隐藏。
 */
export function mountEffortControl(host, options) {
  const doc = host.ownerDocument
  const win = doc.defaultView
  const reduced = win.matchMedia('(prefers-reduced-motion: reduce)')
  const label = options.label ?? '思考强度'
  let info = null
  let pop = null
  let teardownPop = null

  const chip = el(doc, 'button', 'cm-effort-chip', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' })
  const chipText = doc.createElement('span')
  host.appendChild(chip)

  const renderChip = () => {
    chip.hidden = !info
    if (!info) return
    const effort = info.efforts[info.index]
    chip.style.setProperty('--cm-effort-tint', effortTint(effortTier(info.index, info.efforts), options.scheme?.() ?? 'light'))
    chip.replaceChildren(glyph(doc, glyphLevel(info.index, info.efforts)), chipText)
    chipText.textContent = effort.name
    chip.setAttribute('aria-label', `${label}：${effort.name}`)
    chip.title = `${label}：${effort.name}`
  }

  const close = () => {
    if (!pop) return
    const closing = pop
    pop = null
    chip.setAttribute('aria-expanded', 'false')
    teardownPop?.()
    teardownPop = null
    closing.removeAttribute('data-open')
    closing.setAttribute('data-closing', '')
    const ms = parseFloat(win.getComputedStyle(closing).transitionDuration) * 1000 || 0
    win.setTimeout(() => closing.remove(), reduced.matches ? 0 : Math.min(ms, 400))
  }

  const open = (viaKeyboard = false) => {
    if (!info || pop) return
    pop = el(doc, 'div', 'cm-effort-pop', { role: 'dialog', 'aria-label': label, tabindex: '-1' })
    const head = el(doc, 'div', 'cm-effort-head')
    const title = el(doc, 'div', 'cm-effort-title')
    const name = el(doc, 'span', 'cm-effort-name', { 'aria-live': 'polite' })
    const model = el(doc, 'span', 'cm-effort-model')
    title.append(name, model)
    const headGlyphSlot = doc.createElement('span')
    const reset = el(doc, 'button', 'cm-effort-reset', { type: 'button', 'aria-label': options.resetLabel ?? '恢复默认', title: options.resetLabel ?? '恢复默认' })
    reset.appendChild(resetIcon(doc))
    head.append(headGlyphSlot, title, reset)

    const track = el(doc, 'div', 'cm-effort-track')
    const fill = el(doc, 'div', 'cm-effort-fill')
    const canvas = el(doc, 'canvas', 'cm-effort-sparks', { 'aria-hidden': 'true' })
    fill.append(el(doc, 'i', 'cm-on'), el(doc, 'i', 'cm-max'), canvas)
    const thumb = el(doc, 'div', 'cm-effort-thumb', { role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': '0' })
    track.append(fill)
    const sparks = createSparkField(canvas, reduced)
    const labels = el(doc, 'div', 'cm-effort-labels', { 'aria-hidden': 'true' })
    pop.append(head, track, labels)
    doc.body.appendChild(pop)

    // 定位：面板底边贴在胶囊上方 10px，右边与胶囊对齐，不超出窗口。
    const place = () => {
      const r = chip.getBoundingClientRect()
      const left = Math.max(12, Math.min(win.innerWidth - 304 - 12, r.right - 304))
      pop.style.left = `${left}px`
      pop.style.bottom = `${win.innerHeight - r.top + 10}px`
    }
    place()

    let positions = []
    let index = info.index
    const count = info.efforts.length

    // 填充收在滑块下面：圆头比滑块右缘缩进 3px，所以白色滑块旁边不会露出一圈颜色。
    // 被填充盖住的档位圆点隐藏。
    const paint = (x) => {
      thumb.style.setProperty('--cm-x', `${x}px`)
      const edge = Math.max(0, Math.min(track.clientWidth, x + fillReach(EFFORT_THUMB)))
      fill.style.setProperty('--cm-fill', `${edge}px`)
      track.querySelectorAll('.cm-effort-tick').forEach((tick, i) => {
        tick.toggleAttribute('data-covered', positions[i] <= edge - 6)
      })
    }
    const spring = createSpringValue('travel', 0, (x) => {
      paint(x)
      if (reduced.matches) return
      const s = 1 + 0.16 * Math.tanh(Math.abs(spring.velocity) / 1600)
      thumb.style.setProperty('--cm-sx', s.toFixed(3))
      thumb.style.setProperty('--cm-sy', (1 / Math.sqrt(s)).toFixed(3))
    })

    const describe = () => {
      const effort = info.efforts[index]
      const tier = effortTier(index, info.efforts)
      pop.setAttribute('data-tier', tier)
      pop.style.setProperty('--cm-effort-tint', effortTint(tier, options.scheme?.() ?? 'light'))
      sparks.setMode(tier === 'max' ? 'flow' : tier === 'on' ? 'still' : 'none')
      name.textContent = effort.name
      model.textContent = info.modelName ?? ''
      headGlyphSlot.replaceChildren(glyph(doc, glyphLevel(index, info.efforts)))
      thumb.setAttribute('aria-valuemax', String(count - 1))
      thumb.setAttribute('aria-valuenow', String(index))
      thumb.setAttribute('aria-valuetext', effort.name)
      reset.hidden = effort.id === info.defaultEffort
      const shown = count <= 5 ? info.efforts : [info.efforts[0], info.efforts[count - 1]]
      labels.replaceChildren(...shown.map((e) => {
        const span = doc.createElement('span')
        span.textContent = e.name
        if (e.id === effort.id) span.setAttribute('data-on', '')
        return span
      }))
    }

    const layout = () => {
      positions = stopPositions(count, track.clientWidth)
      fill.style.setProperty('--cm-track-w', `${track.clientWidth}px`)
      sparks.resize(track.clientWidth, track.clientHeight)
      track.querySelectorAll('.cm-effort-tick').forEach((t) => t.remove())
      for (const p of positions) {
        const tick = el(doc, 'span', 'cm-effort-tick')
        tick.style.left = `${p}px`
        track.insertBefore(tick, thumb.parentNode ? thumb : null)
      }
      track.appendChild(thumb)
      spring.jumpTo(positions[index])
    }

    const commit = (next) => {
      const changed = next !== index
      index = next
      describe()
      spring.retune('travel')
      if (reduced.matches) spring.jumpTo(positions[index])
      else spring.animateTo(positions[index])
      if (changed) Promise.resolve(options.onSelect?.(info.efforts[index].id)).catch(() => {})
    }

    // 拖动：一次按压只有一个所有者（滑块或轨道），松手只提交一次。
    let drag = null
    const toTrackX = (event) => event.clientX - track.getBoundingClientRect().left
    const onDown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      track.setPointerCapture(event.pointerId)
      thumb.focus({ preventScroll: true })
      thumb.setAttribute('data-pressed', '')
      const x = toTrackX(event)
      drag = { id: event.pointerId, target: x, vx: 0, t: event.timeStamp, x }
      spring.retune('follow')
      const limit = (positions[1] - positions[0]) * 0.3 || 24
      if (reduced.matches) spring.jumpTo(band(x, positions[0], positions[count - 1], limit))
      else spring.animateTo(band(x, positions[0], positions[count - 1], limit))
    }
    const onMove = (event) => {
      if (!drag || event.pointerId !== drag.id) return
      const x = toTrackX(event)
      const dt = Math.max(1, event.timeStamp - drag.t) / 1000
      drag.vx = drag.vx * 0.6 + ((x - drag.x) / dt) * 0.4
      drag.x = x
      drag.t = event.timeStamp
      drag.target = x
      const limit = (positions[1] - positions[0]) * 0.3 || 24
      const banded = band(x, positions[0], positions[count - 1], limit)
      if (reduced.matches) spring.jumpTo(banded)
      else spring.animateTo(banded)
      const near = nearestStop(positions, x)
      if (near !== index) {
        index = near
        describe()
      }
    }
    const onUp = (event) => {
      if (!drag || event.pointerId !== drag.id) return
      const { target, vx } = drag
      drag = null
      thumb.removeAttribute('data-pressed')
      thumb.style.setProperty('--cm-sx', '1')
      thumb.style.setProperty('--cm-sy', '1')
      const previous = info.index
      index = previous
      commit(projectStop(positions, target, vx))
    }
    const onKey = (event) => {
      const map = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }
      let next = index
      if (event.key in map) next = Math.max(0, Math.min(count - 1, index + map[event.key]))
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = count - 1
      else if (event.key === 'Escape') { close(); chip.focus(); return } else return
      event.preventDefault()
      commit(next)
    }
    const onReset = () => commit(Math.max(0, info.efforts.findIndex((e) => e.id === info.defaultEffort)))
    const onOutside = (event) => { if (!pop?.contains(event.target) && !chip.contains(event.target)) close() }
    const onResize = () => { place(); layout() }

    track.addEventListener('pointerdown', onDown)
    track.addEventListener('pointermove', onMove)
    track.addEventListener('pointerup', onUp)
    track.addEventListener('pointercancel', onUp)
    thumb.addEventListener('keydown', onKey)
    reset.addEventListener('click', onReset)
    doc.addEventListener('pointerdown', onOutside, true)
    win.addEventListener('resize', onResize)

    describe()
    layout()
    chip.setAttribute('aria-expanded', 'true')
    win.requestAnimationFrame(() => pop?.setAttribute('data-open', ''))
    // 只有键盘打开时才把焦点交给滑块（这时需要看到焦点环）；鼠标打开时焦点落在面板上，
    // 滑块外面不会多出一圈焦点环。两种情况下 Esc 都能关闭面板。
    if (viaKeyboard) thumb.focus({ preventScroll: true })
    else pop.focus({ preventScroll: true })
    pop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { close(); chip.focus({ preventScroll: true }) }
    })

    teardownPop = () => {
      spring.stop()
      sparks.dispose()
      doc.removeEventListener('pointerdown', onOutside, true)
      win.removeEventListener('resize', onResize)
    }
    pop.cmSync = () => {
      if (!info) return close()
      if (!drag && info.index !== index) {
        index = info.index
        describe()
        spring.retune('travel')
        spring.animateTo(positions[index])
      }
    }
  }

  // event.detail 为 0 表示由键盘（回车或空格）触发的点击。
  chip.addEventListener('click', (event) => (pop ? close() : open(event.detail === 0)))

  return {
    update(next) {
      info = next
      renderChip()
      pop?.cmSync?.()
    },
    dispose() {
      close()
      chip.remove()
    },
  }
}
