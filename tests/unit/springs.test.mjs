import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPRINGS, createSpringValue, springEasing, springParams, springSettleMs, springStep,
} from '../../plugins/pastel-theme/src/springs.js'

// 参照值来自 liquid-glass-motion Skill 的 motion-physics.md 第 2 节 token 表。
const TABLE = {
  track: { k: 2741.6, zeta: 1.0, overshoot: 0, settle: 177 },
  fade: { k: 987.0, zeta: 1.0, overshoot: 0, settle: 294 },
  follow: { k: 987.0, zeta: 0.9, overshoot: 0.0015, settle: 267 },
  press: { k: 304.6, zeta: 0.6, overshoot: 0.095, settle: 631 },
  travel: { k: 246.7, zeta: 0.85, overshoot: 0.0063, settle: 566 },
  settle: { k: 157.9, zeta: 0.68, overshoot: 0.054, settle: 845 },
  jelly: { k: 99.5, zeta: 0.4, overshoot: 0.254, settle: 1643 },
}

const peak = (name) => {
  let max = 0
  for (let t = 0; t < 3; t += 0.0005) max = Math.max(max, springStep(name, t))
  return max
}

test('刚度和阻尼比与 Skill 的 token 表一致', () => {
  for (const [name, row] of Object.entries(TABLE)) {
    const { stiffness, zeta } = springParams(name)
    assert.ok(Math.abs(stiffness - row.k) < 0.2, `${name} k=${stiffness}`)
    assert.ok(Math.abs(zeta - row.zeta) < 1e-9, `${name} ζ=${zeta}`)
  }
})

test('过冲与 Skill 的 token 表一致，bounce 为 0 的 token 不过冲', () => {
  for (const [name, row] of Object.entries(TABLE)) {
    const over = peak(name) - 1
    if (row.overshoot === 0) assert.ok(over <= 1e-9, `${name} 不应过冲，实际 ${over}`)
    else assert.ok(Math.abs(over - row.overshoot) < 0.003, `${name} 过冲 ${over}，期望 ${row.overshoot}`)
  }
})

test('稳定时间与 Skill 的 token 表一致（误差 ±5ms）', () => {
  for (const [name, row] of Object.entries(TABLE)) {
    const ms = springSettleMs(name)
    assert.ok(Math.abs(ms - row.settle) <= 5, `${name} 稳定 ${ms}ms，期望 ${row.settle}ms`)
  }
})

test('CSS linear() 缓动：从 0 开始、以 1 结束；fade 单调且不超过 1', () => {
  for (const name of Object.keys(SPRINGS)) {
    const { easing, ms } = springEasing(name)
    const points = easing.slice(7, -1).split(', ').map(Number)
    assert.equal(points[0], 0)
    assert.equal(points.at(-1), 1)
    assert.ok(ms > 0)
  }
  const fade = springEasing('fade').easing.slice(7, -1).split(', ').map(Number)
  for (let i = 1; i < fade.length; i++) assert.ok(fade[i] >= fade[i - 1] && fade[i] <= 1)
})

/** 一个可手动推进的帧时钟：raf 入队，run(n) 每次推进 16.67ms。 */
function clock() {
  let now = 0
  const queue = []
  return {
    raf: (fn) => { queue.push(fn); return queue.length },
    caf: () => {},
    run(frames) { for (let i = 0; i < frames && queue.length; i++) { now += 16.67; queue.shift()(now) } },
  }
}

test('弹簧值：中途改目标时保留速度（Skill 规律 2：速度接力）', () => {
  const a = clock()
  const moving = createSpringValue('follow', 0, () => {}, a.raf, a.caf)
  moving.animateTo(100)
  a.run(3)
  const from = moving.value
  moving.animateTo(-50)
  a.run(1)

  // 对照组：同一位置、零速度起步，朝同一个新目标走一帧。
  const b = clock()
  const fresh = createSpringValue('follow', from, () => {}, b.raf, b.caf)
  fresh.animateTo(-50)
  b.run(1)

  // 保留了向上的速度，所以这一帧应该比"零速度重启"的对照组更靠上。
  assert.ok(moving.value > fresh.value + 1, `速度应被接力：保速 ${moving.value}，重启 ${fresh.value}`)
})

test('弹簧值：静止后精确落在目标上，并停止帧回调', () => {
  const c = clock()
  const spring = createSpringValue('settle', 0, () => {}, c.raf, c.caf)
  spring.animateTo(120)
  c.run(600)
  assert.equal(spring.running, false)
  assert.equal(spring.value, 120)
})
