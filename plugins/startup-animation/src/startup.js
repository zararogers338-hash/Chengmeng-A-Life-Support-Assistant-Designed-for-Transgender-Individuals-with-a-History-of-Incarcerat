/**
 * 启动动画的样式与 DOM 控制器。不依赖 DSH 和 React：预览页和 DSH 客户端插件共用同一份实现。
 *
 * 叙事（docs/DESIGN.md）：光穿过玻璃。一排纸白色的玻璃条盖在界面上，上面是实验室终端风格的检查清单；
 * 全部就绪后，玻璃条自左向右依次向上揭开，露出下面真实的壁纸和工作界面。
 * 因为是"揭开"，不是"淡出"，所以交接天然无缝，不需要复制壁纸。
 *
 * 动效规则（liquid-glass-motion Skill）：
 * - 只用弹簧 token：玻璃条上滑用 push（不过冲），进度推进用 travel，文字和颜色用 fade（不回弹）。
 * - 没有任何循环动画：只有状态驱动的运动。
 * - 弹性只改绘制（transform / opacity），不改布局。
 *
 * 风格是原创的：冷静的科研终端，浅冷白、细线、等宽状态行、蓝白色光。不使用任何游戏的 Logo、角色或素材。
 *
 * 构建脚本会把本文件内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`，
 * 以及指向 src 内其他模块的单行相对 import（构建时剥掉）。
 */
import { springCSSVariables } from './springs.js'
import { lineStatus, nextDueAt, phaseAt, progressAt, schedule, slatCount } from './schedule.js'

export const DEFAULT_LABELS = Object.freeze({
  boot: '正在启动',
  ready: '就绪',
  waiting: '检查中',
  timeout: '超时',
  skipped: '已跳过',
  skip: '跳过',
})

export function startupCSS() {
  const fade = 'var(--cm-spring-fade-ms) var(--cm-spring-fade)'
  const push = 'var(--cm-spring-push-ms) var(--cm-spring-push)'
  const travel = 'var(--cm-spring-travel-ms) var(--cm-spring-travel)'
  const mono = 'ui-monospace,"Cascadia Mono","SF Mono",Consolas,"Liberation Mono",monospace'
  return `
.cm-boot-host{position:absolute;inset:0;pointer-events:none}
.cm-boot{${springCSSVariables()};position:absolute;inset:0;overflow:hidden;pointer-events:auto;cursor:default;user-select:none;-webkit-user-select:none;-webkit-app-region:initial;
  --cm-boot-slat-a:#F7F9FB;--cm-boot-slat-b:#EEF2F7;--cm-boot-grid:rgb(30 36 51 / .05);--cm-boot-edge:rgb(255 255 255 / .9);--cm-boot-ink:#1E2433;--cm-boot-dim:#8A90A6;--cm-boot-mid:#5B6178;
  --cm-boot-cyan:#1CCBFC;--cm-boot-blue:#3B82F6;--cm-boot-warn:#B45309;--cm-boot-track:rgb(30 36 51 / .12);--cm-boot-lift:rgb(30 60 120 / .32)}
body[data-ds-dark-theme] .cm-boot{--cm-boot-slat-a:#171A22;--cm-boot-slat-b:#10131A;--cm-boot-grid:rgb(255 255 255 / .05);--cm-boot-edge:rgb(255 255 255 / .06);--cm-boot-ink:#E8EAF2;--cm-boot-dim:#6F7690;--cm-boot-mid:#A3A8BD;--cm-boot-track:rgb(255 255 255 / .14);--cm-boot-lift:rgb(0 0 0 / .5)}

.cm-boot__slat{position:absolute;top:0;bottom:0;transform:translateY(0);
  background:linear-gradient(180deg,var(--cm-boot-slat-a),var(--cm-boot-slat-b)),repeating-linear-gradient(0deg,transparent 0 47px,var(--cm-boot-grid) 47px 48px);
  background-blend-mode:normal;box-shadow:inset -1px 0 0 var(--cm-boot-edge);transition:transform ${push},box-shadow ${fade}}
.cm-boot__slat::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 47px,var(--cm-boot-grid) 47px 48px);pointer-events:none}
.cm-boot__slat::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,transparent,var(--cm-boot-cyan),transparent);opacity:0;transition:opacity ${fade}}
.cm-boot[data-phase=leave] .cm-boot__slat,.cm-boot[data-phase=done] .cm-boot__slat{transform:translateY(-104%);box-shadow:inset -1px 0 0 var(--cm-boot-edge),0 26px 44px -22px var(--cm-boot-lift);transition-delay:calc(var(--cm-fade-ms,260ms) + var(--i) * var(--cm-stagger,70ms))}
.cm-boot[data-phase=leave] .cm-boot__slat::after,.cm-boot[data-phase=done] .cm-boot__slat::after{opacity:.9;transition-delay:calc(var(--cm-fade-ms,260ms) + var(--i) * var(--cm-stagger,70ms))}

.cm-boot__content{position:absolute;inset:0;display:grid;place-items:center;transition:opacity ${fade}}
.cm-boot[data-phase=leave] .cm-boot__content,.cm-boot[data-phase=done] .cm-boot__content{opacity:0}
.cm-boot__panel{width:min(440px,calc(100% - 56px));color:var(--cm-boot-ink)}
.cm-boot__corner{position:absolute;width:16px;height:16px;border:0 solid var(--cm-boot-mid);opacity:0;transition:opacity ${fade}}
.cm-boot[data-in] .cm-boot__corner{opacity:.55}
.cm-boot__corner[data-c=tl]{top:28px;left:28px;border-top-width:1px;border-left-width:1px}
.cm-boot__corner[data-c=tr]{top:28px;right:28px;border-top-width:1px;border-right-width:1px}
.cm-boot__corner[data-c=bl]{bottom:28px;left:28px;border-bottom-width:1px;border-left-width:1px}
.cm-boot__corner[data-c=br]{bottom:28px;right:28px;border-bottom-width:1px;border-right-width:1px}

.cm-boot__word{display:flex;justify-content:center;font:300 clamp(30px,5.2vw,52px)/1.1 "Segoe UI Variable Display","Segoe UI","Helvetica Neue",system-ui,sans-serif;letter-spacing:.3em;text-transform:uppercase;padding-left:.3em}
.cm-boot__letter{display:inline-block;opacity:0;transform:translateY(8px);transition:opacity ${fade},transform ${push};transition-delay:calc(var(--i) * 38ms)}
.cm-boot[data-in] .cm-boot__letter{opacity:1;transform:none}
.cm-boot__sub{margin-top:10px;text-align:center;font:11px/1.4 ${mono};letter-spacing:.32em;text-transform:uppercase;color:var(--cm-boot-dim);opacity:0;transition:opacity ${fade};transition-delay:420ms}
.cm-boot[data-in] .cm-boot__sub{opacity:1}

.cm-boot__bar{position:relative;height:2px;margin:30px 0 22px;border-radius:2px;background:var(--cm-boot-track);overflow:hidden;transform:scaleX(0);transform-origin:left;transition:transform ${push};transition-delay:180ms}
.cm-boot[data-in] .cm-boot__bar{transform:scaleX(1)}
.cm-boot__fill{position:absolute;inset:0;transform-origin:left;transform:scaleX(var(--cm-p,0));background:linear-gradient(90deg,var(--cm-boot-cyan),var(--cm-boot-blue));box-shadow:0 0 10px rgb(28 203 252 / .6);transition:transform ${travel}}

.cm-boot__lines{display:grid;gap:2px;font:12px/1.9 ${mono};letter-spacing:.06em}
.cm-boot__line{display:grid;grid-template-columns:14px 1fr auto auto;align-items:center;column-gap:10px;color:var(--cm-boot-dim);opacity:0;transform:translateY(5px);transition:opacity ${fade},transform ${push},color ${fade};transition-delay:calc(560ms + var(--i) * 90ms)}
.cm-boot[data-in] .cm-boot__line{opacity:1;transform:none}
.cm-boot__dot{width:7px;height:7px;border-radius:50%;box-sizing:border-box;border:1px solid var(--cm-boot-dim);background:transparent;transition:background-color ${fade},border-color ${fade},box-shadow ${fade}}
.cm-boot__code{color:inherit;text-transform:uppercase;opacity:.6}
.cm-boot__state{min-width:3.6em;text-align:right}
.cm-boot__line[data-status=ok]{color:var(--cm-boot-ink)}
.cm-boot__line[data-status=ok] .cm-boot__dot{border-color:var(--cm-boot-cyan);background:var(--cm-boot-cyan);box-shadow:0 0 8px rgb(28 203 252 / .75)}
.cm-boot__line[data-status=ok] .cm-boot__state{color:var(--cm-boot-blue)}
.cm-boot__line[data-status=timeout]{color:var(--cm-boot-warn)}
.cm-boot__line[data-status=timeout] .cm-boot__dot{border-color:var(--cm-boot-warn)}

.cm-boot__foot{position:absolute;left:28px;right:28px;bottom:26px;display:flex;justify-content:space-between;align-items:center;font:11px/1 ${mono};letter-spacing:.14em;color:var(--cm-boot-dim);opacity:0;transition:opacity ${fade};transition-delay:700ms}
.cm-boot[data-in] .cm-boot__foot{opacity:1}
.cm-boot__skip{appearance:none;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:inherit;cursor:pointer;padding:8px 4px;border-radius:6px}
.cm-boot__skip:hover{color:var(--cm-boot-ink)}
.cm-boot__skip:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176E6);outline-offset:2px}

@media (prefers-reduced-motion:reduce){.cm-boot *,.cm-boot *::before,.cm-boot *::after{transition:none!important}}
`
}

const el = (doc, tag, cls, attrs = {}) => {
  const node = doc.createElement(tag)
  if (cls) node.className = cls
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}

/**
 * 挂载启动动画。
 * options:
 *   checks   [{ id, label, code, wait(signal) → Promise }]：每项检查在"真的就绪"时 resolve。
 *   name     显示名称（由统一配置给出）。
 *   version  可选，显示 DSH 版本号。
 *   slats    可选，[{ left, width }]（像素，相对 host）：对齐壁纸玻璃条；没有就按 count 均分。
 *   labels   可选，覆盖界面文字。
 *   onDone   ({ skipped, timedOut, elapsed }) → void，只调用一次。
 *   now      可选，时钟（测试用）。
 * 返回 { skip(), dispose(), root }。
 */
export function mountStartup(host, options) {
  const doc = host.ownerDocument
  const win = doc.defaultView
  const now = options.now ?? (() => win.performance.now())
  const labels = { ...DEFAULT_LABELS, ...options.labels }
  const checks = options.checks ?? []
  const hostWidth = host.clientWidth || win.innerWidth
  const fallbackCount = slatCount(hostWidth)
  const slatBoxes = options.slats?.length >= 3
    ? options.slats
    : Array.from({ length: fallbackCount }, (_, i) => ({ left: (hostWidth / fallbackCount) * i, width: hostWidth / fallbackCount }))

  const t0 = now()
  const passedAt = checks.map(() => null)
  let skippedAt = null
  let finished = false
  let timer = 0
  let frame = 0
  const controller = new win.AbortController()

  const root = el(doc, 'div', 'cm-boot', { role: 'status', 'aria-label': labels.boot, 'aria-live': 'off' })

  // 用百分比定位：动画播放的几秒里窗口大小变了，玻璃条也始终盖满，不会漏出一块。
  // 宽度多 1px，避免相邻两条之间出现发丝缝。
  slatBoxes.forEach((box, i) => {
    const slat = el(doc, 'div', 'cm-boot__slat')
    slat.style.left = `${((box.left / hostWidth) * 100).toFixed(4)}%`
    slat.style.width = `calc(${((box.width / hostWidth) * 100).toFixed(4)}% + 1px)`
    slat.style.setProperty('--i', String(i))
    root.appendChild(slat)
  })

  const content = el(doc, 'div', 'cm-boot__content')
  const panel = el(doc, 'div', 'cm-boot__panel')

  const word = el(doc, 'div', 'cm-boot__word', { role: 'img', 'aria-label': options.name })
  Array.from(options.name).forEach((char, i) => {
    const letter = el(doc, 'span', 'cm-boot__letter', { 'aria-hidden': 'true' })
    letter.style.setProperty('--i', String(i))
    letter.textContent = char
    word.appendChild(letter)
  })
  const sub = el(doc, 'div', 'cm-boot__sub')
  sub.textContent = 'Life support terminal'

  const bar = el(doc, 'div', 'cm-boot__bar', { 'aria-hidden': 'true' })
  const fill = el(doc, 'div', 'cm-boot__fill')
  bar.appendChild(fill)

  const lines = el(doc, 'div', 'cm-boot__lines')
  const lineNodes = checks.map((check, i) => {
    const line = el(doc, 'div', 'cm-boot__line', { 'data-status': 'waiting' })
    line.style.setProperty('--i', String(i))
    const dot = el(doc, 'span', 'cm-boot__dot', { 'aria-hidden': 'true' })
    const label = doc.createElement('span')
    label.textContent = check.label
    const code = el(doc, 'span', 'cm-boot__code', { 'aria-hidden': 'true' })
    code.textContent = check.code
    const state = el(doc, 'span', 'cm-boot__state')
    state.textContent = labels.waiting
    line.append(dot, label, code, state)
    lines.appendChild(line)
    return { line, state }
  })

  panel.append(word, sub, bar, lines)
  content.appendChild(panel)
  root.appendChild(content)

  for (const corner of ['tl', 'tr', 'bl', 'br']) root.appendChild(el(doc, 'div', 'cm-boot__corner', { 'data-c': corner, 'aria-hidden': 'true' }))

  const foot = el(doc, 'div', 'cm-boot__foot')
  const version = doc.createElement('span')
  version.textContent = options.version ? `DSH ${options.version}` : ''
  const skipButton = el(doc, 'button', 'cm-boot__skip', { type: 'button' })
  skipButton.textContent = `${labels.skip} · Esc`
  foot.append(version, skipButton)
  root.appendChild(foot)

  host.appendChild(root)

  const plan = () => schedule({ passedAt, skippedAt, slats: slatBoxes.length })

  const finish = (p) => {
    if (finished) return
    finished = true
    win.clearTimeout(timer)
    win.cancelAnimationFrame(frame)
    controller.abort()
    doc.removeEventListener('keydown', onKey, true)
    root.remove()
    options.onDone?.({ skipped: p.skipped, timedOut: p.timedOut, elapsed: now() - t0 })
  }

  const render = () => {
    if (finished) return
    const elapsed = now() - t0
    const p = plan()
    const phase = phaseAt(p, elapsed)
    if (phase === 'done') return finish(p)
    root.dataset.phase = phase
    root.style.setProperty('--cm-p', String(progressAt(p, elapsed)))
    root.style.setProperty('--cm-fade-ms', `${p.timing.textFadeMs}ms`)
    root.style.setProperty('--cm-stagger', `${p.timing.slatStaggerMs}ms`)
    lineNodes.forEach(({ line, state }, i) => {
      const status = lineStatus(p, i, elapsed)
      if (line.dataset.status !== status) {
        line.dataset.status = status
        state.textContent = labels[status === 'ok' ? 'ready' : status]
      }
    })
    const due = nextDueAt(p, elapsed)
    win.clearTimeout(timer)
    if (due != null) timer = win.setTimeout(render, Math.max(0, due - elapsed) + 1)
  }

  const skip = () => {
    if (finished || skippedAt != null) return
    skippedAt = now() - t0
    render()
  }

  // 按任意键跳过，但不拦截：字符照常进输入框。修饰键单独按下不算。
  const onKey = (event) => {
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(event.key)) return
    skip()
  }
  doc.addEventListener('keydown', onKey, true)
  root.addEventListener('pointerdown', skip)
  skipButton.addEventListener('click', skip)

  // 检查项：每一项真的就绪才记录时间。出错不算通过，退场时显示"超时"。
  checks.forEach((check, i) => {
    Promise.resolve()
      .then(() => check.wait(controller.signal))
      .then(() => {
        if (finished || passedAt[i] != null) return
        passedAt[i] = now() - t0
        render()
      })
      .catch(() => {})
  })

  render()
  // 下一帧再打开 data-in：第一帧先以隐藏状态绘制，过渡才会真的播放。
  // 窗口被遮挡或最小化时 requestAnimationFrame 不会触发，所以加一个定时器兜底，保证内容最终会出现。
  const reveal = () => { if (!finished) root.setAttribute('data-in', '') }
  frame = win.requestAnimationFrame(reveal)
  win.setTimeout(reveal, 80)

  return { skip, root, dispose: () => finish(plan()) }
}
