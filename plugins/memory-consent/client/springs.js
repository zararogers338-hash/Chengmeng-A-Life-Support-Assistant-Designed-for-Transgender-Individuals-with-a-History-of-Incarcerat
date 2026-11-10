/**
 * 弹簧物理：移植自 liquid-glass-motion Skill（项目所有者原创）的 Prism 动效 token。
 *
 * 每个运动都是质量为 1 的阻尼弹簧，用两个感知参数描述：时长 d 决定快慢，bounce b 决定性格。
 *   刚度 k = (2π/d)²；b > 0 时阻尼比 ζ = 1 − b，b ≤ 0 时 ζ = 1/(1 + b)。
 * CSS 只接受"时长 + 曲线"，所以这里按 Skill 里 SpringCurve 的思路，把弹簧的阶跃响应采样成
 * CSS `linear()` 缓动，transition 的时长取弹簧真正稳定下来的时间。
 * 规则：透明度、颜色、模糊永远用 bounce 为 0 的 token（fade、lift），只有几何属性可以回弹。
 *
 * 构建脚本会把本文件内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`。
 */

/** token 名 → [时长 ms, bounce]，与 Skill 的 motion-physics.md 第 2 节一一对应。 */
export const SPRINGS = Object.freeze({
  track: [120, 0],
  fade: [200, 0],
  follow: [200, 0.1],
  lift: [250, 0],
  push: [300, 0],
  pop: [300, 0.5],
  press: [360, 0.4],
  toggle: [380, 0.25],
  travel: [400, 0.15],
  sheet: [420, 0.08],
  settle: [500, 0.32],
  jelly: [630, 0.6],
})

export function springParams(name) {
  const token = SPRINGS[name]
  if (!token) throw new Error(`未知的弹簧 token：${name}`)
  const [ms, bounce] = token
  const omega = (2 * Math.PI) / (ms / 1000)
  const zeta = bounce > 0 ? 1 - bounce : 1 / (1 + bounce)
  return { ms, bounce, omega, zeta, stiffness: omega * omega, damping: 2 * zeta * omega }
}

/** 静止起步、目标为 1 的阶跃响应 x(t)，t 的单位是秒。 */
export function springStep(name, t) {
  const { omega, zeta } = springParams(name)
  if (zeta >= 1) return 1 - Math.exp(-omega * t) * (1 + omega * t)
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t))
}

/** 阶跃响应的速度 x'(t)（解析解），单位是每秒。 */
export function springVelocity(name, t) {
  const { omega, zeta } = springParams(name)
  if (zeta >= 1) return omega * omega * t * Math.exp(-omega * t)
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  return Math.exp(-zeta * omega * t) * Math.sin(wd * t) * ((omega * omega) / wd)
}

/**
 * 稳定时间（毫秒）：按毫秒扫描，第一次同时满足"离目标小于容差、速度小于容差 × ω₀"的时刻。
 * 与 Skill 的 SpringToken.settleTime 和 spring_lab.py 的 settle_ms 使用同一条规则。
 */
export function springSettleMs(name, tolerance = 1e-3) {
  const { omega } = springParams(name)
  for (let ms = 0; ms <= 10000; ms++) {
    const t = ms / 1000
    if (Math.abs(springStep(name, t) - 1) < tolerance && Math.abs(springVelocity(name, t)) < tolerance * omega) return ms
  }
  return 10000
}

/**
 * 把弹簧采样成 CSS `linear()` 缓动，返回 { easing, ms }。
 * 采样点在时间上均匀分布；最后一个点固定为 1，消除容差内的残差（与 SpringCurve 相同的处理）。
 */
export function springEasing(name, samples = 32) {
  const ms = springSettleMs(name)
  const points = []
  for (let i = 0; i <= samples; i++) {
    const x = i === samples ? 1 : springStep(name, (ms / 1000) * (i / samples))
    points.push(Math.round(x * 10000) / 10000)
  }
  return { easing: `linear(${points.join(', ')})`, ms }
}

/** 每个 token 的 CSS 变量：--cm-spring-<name> 是缓动，--cm-spring-<name>-ms 是时长。 */
export function springCSSVariables() {
  return Object.keys(SPRINGS)
    .map((name) => {
      const { easing, ms } = springEasing(name)
      return `--cm-spring-${name}:${easing};--cm-spring-${name}-ms:${ms}ms`
    })
    .join(';')
}

/**
 * 逐帧追踪的弹簧值（对应 Skill 里的 SpringValue）：中途改目标时保留当前位置和速度，
 * 静止后自动停下，不再占用帧回调。时间步长会被切成小步，避免掉帧时数值发散。
 */
export function createSpringValue(name, initial, onFrame, raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame) {
  let { stiffness, damping, omega } = springParams(name)
  let x = initial
  let v = 0
  let target = initial
  let frame = 0
  let lastTime = 0
  const rest = 0.5

  const step = (now) => {
    let dt = Math.min(0.064, lastTime ? (now - lastTime) / 1000 : 1 / 60)
    lastTime = now
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240)
      v += (-stiffness * (x - target) - damping * v) * h
      x += v * h
      dt -= h
    }
    if (Math.abs(x - target) < rest && Math.abs(v) < rest * omega) {
      x = target
      v = 0
      frame = 0
      lastTime = 0
      onFrame(x)
      return
    }
    onFrame(x)
    frame = raf(step)
  }

  return {
    get value() { return x },
    get velocity() { return v },
    get running() { return frame !== 0 },
    /** 换一个 token 继续运动：保留当前位置和速度（例如拖动时 follow，松手后 travel）。 */
    retune(nextName) {
      ({ stiffness, damping, omega } = springParams(nextName))
    },
    animateTo(next) {
      target = next
      if (!frame) frame = raf(step)
    },
    jumpTo(next) {
      if (frame) caf(frame)
      frame = 0
      lastTime = 0
      x = target = next
      v = 0
      onFrame(x)
    },
    stop() {
      if (frame) caf(frame)
      frame = 0
    },
  }
}
