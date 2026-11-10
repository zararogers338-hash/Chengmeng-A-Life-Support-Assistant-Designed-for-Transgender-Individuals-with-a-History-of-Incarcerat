/**
 * 启动动画的时间调度。全部是纯函数，不碰 DOM、不读时钟：给定"每项检查是什么时候真的通过的"，
 * 算出每一行什么时候亮起、什么时候开始退场、什么时候结束。运行时每当有一项检查通过就重算一次。
 *
 * 核心规则：时间线由真实信号驱动，而不是写死的定时器。
 * - 一行最早在进场结束时亮起；相邻两行至少间隔 lineGapMs，这样每一行都读得到。
 * - 全部通过后再停 holdMs，且总时长不少于 minTotalMs，然后退场。
 * - 总时长有硬上限 maxTotalMs：到点必定退场，没通过的行标记"超时"。动画永远不会卡住 DSH。
 * - 跳过：立即退场。
 *
 * 构建脚本会把本文件内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`。
 */

export const TIMING = Object.freeze({
  enterMs: 520,
  lineGapMs: 220,
  holdMs: 380,
  minTotalMs: 1700,
  maxTotalMs: 5000,
  textFadeMs: 260,
  slatStaggerMs: 70,
  slatLiftMs: 440,
})

/** 是否播放。减少动态效果：不播放（状态立即生效，Skill 规律 7）。 */
export function shouldPlay({ disabledByUser, reducedMotion, alreadyPlayed }) {
  return !disabledByUser && !reducedMotion && !alreadyPlayed
}

/** 玻璃条数量，只用于视觉。有壁纸时运行时会改用壁纸玻璃条的真实位置，这里是没有壁纸时的默认值。 */
export function slatCount(width) {
  if (!Number.isFinite(width) || width <= 0) return 6
  if (width < 640) return 4
  if (width < 1024) return 6
  return Math.max(6, Math.min(12, Math.round(width / 180)))
}

/**
 * 生成计划。
 * passedAt：每项检查通过的时间（毫秒，相对启动），还没通过的是 null。
 * skippedAt：用户按了跳过的时间，没有就是 null。
 * slats：玻璃条数量，用来算整体结束时间。
 */
export function schedule({ passedAt, skippedAt = null, slats = 8, timing } = {}) {
  const t = { ...TIMING, ...timing }
  // 硬上限之后才通过的检查一律当作"没通过"：退场已经由上限决定，不能事后改写成"没超时"。
  const passed = (passedAt ?? []).map((at) => (at != null && at <= t.maxTotalMs ? at : null))

  // 按"通过的先后"分配亮起时间，而不是按行的顺序：后一项先通过，它也不必等前一项。
  const order = passed
    .map((at, index) => ({ at, index }))
    .filter((entry) => entry.at != null)
    .sort((a, b) => a.at - b.at || a.index - b.index)
  const shownAt = passed.map(() => null)
  let last = -Infinity
  for (const { at, index } of order) {
    const shown = Math.max(at, t.enterMs, last + t.lineGapMs)
    shownAt[index] = shown
    last = shown
  }

  const allPassed = passed.every((at) => at != null)
  const lastShown = order.length > 0 ? shownAt[order.at(-1).index] : t.enterMs
  const readyAt = allPassed ? Math.max(lastShown + t.holdMs, t.minTotalMs) : null
  const leaveAt = Math.min(readyAt ?? Infinity, skippedAt ?? Infinity, t.maxTotalMs)
  const skipped = skippedAt != null && skippedAt <= leaveAt
  const timedOut = !allPassed && !skipped && leaveAt >= t.maxTotalMs
  const doneAt = leaveAt + t.textFadeMs + Math.max(0, slats - 1) * t.slatStaggerMs + t.slatLiftMs

  return { shownAt, readyAt, leaveAt, doneAt, skipped, timedOut, enterMs: t.enterMs, timing: t }
}

/** 当前阶段：进场 → 检查 → 退场 → 结束。跳过发生在进场期间时，退场优先。 */
export function phaseAt(plan, elapsed) {
  if (elapsed >= plan.doneAt) return 'done'
  if (elapsed >= plan.leaveAt) return 'leave'
  if (elapsed < plan.enterMs) return 'enter'
  return 'check'
}

/** 某一行的状态：ok 已就绪；waiting 还在等；timeout / skipped 退场时仍没通过。 */
export function lineStatus(plan, index, elapsed) {
  const shown = plan.shownAt[index]
  if (shown != null && elapsed >= shown) return 'ok'
  if (elapsed >= plan.leaveAt) return plan.skipped ? 'skipped' : 'timeout'
  return 'waiting'
}

/** 进度 0..1：已亮起的行数 / 总行数。没有检查项时按进场是否结束算。 */
export function progressAt(plan, elapsed) {
  const total = plan.shownAt.length
  if (total === 0) return elapsed >= plan.enterMs ? 1 : 0
  return plan.shownAt.filter((at) => at != null && elapsed >= at).length / total
}

/** 下一个需要重新渲染的时间点（毫秒，相对启动）；没有就返回 null。 */
export function nextDueAt(plan, elapsed) {
  const due = [...plan.shownAt, plan.enterMs, plan.leaveAt, plan.doneAt].filter((at) => at != null && at > elapsed)
  return due.length > 0 ? Math.min(...due) : null
}
