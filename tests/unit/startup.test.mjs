import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TIMING, lineStatus, nextDueAt, phaseAt, progressAt, schedule, shouldPlay, slatCount,
} from '../../plugins/startup-animation/src/schedule.js'
import {
  DEFAULT_AGENT_NAME, agentDisplayName, readSetting, startupDisabled,
} from '../../plugins/startup-animation/src/config.js'
import { startupCSS } from '../../plugins/startup-animation/src/startup.js'

const T = TIMING

test('时间线由真实信号驱动：检查还没通过就一直等，不会因为"时间到了"而假装通过', () => {
  const plan = schedule({ passedAt: [null, null, null], slats: 8 })
  assert.equal(plan.readyAt, null)
  assert.deepEqual(plan.shownAt, [null, null, null])
  // 只有硬上限会让它退场，并且没通过的行标记为超时。
  assert.equal(plan.leaveAt, T.maxTotalMs)
  assert.equal(plan.timedOut, true)
  assert.equal(lineStatus(plan, 0, T.maxTotalMs - 1), 'waiting')
  assert.equal(lineStatus(plan, 0, T.maxTotalMs), 'timeout')
})

test('一行最早在进场结束时亮起；相邻两行至少间隔 lineGapMs，每一行都读得到', () => {
  const plan = schedule({ passedAt: [10, 20, 30], slats: 8 })
  assert.equal(plan.shownAt[0], T.enterMs, '早通过的也要等进场结束')
  assert.equal(plan.shownAt[1], T.enterMs + T.lineGapMs)
  assert.equal(plan.shownAt[2], T.enterMs + 2 * T.lineGapMs)
})

test('检查很晚才通过时，那一行就在它通过的那一刻亮起，不会被提前', () => {
  const plan = schedule({ passedAt: [100, 2400, 300], slats: 8 })
  assert.equal(plan.shownAt[1], 2400)
  assert.ok(plan.shownAt[0] < plan.shownAt[2] && plan.shownAt[2] < plan.shownAt[1])
})

test('后一项先通过，它不用等前一项（按通过的先后，而不是按行的顺序）', () => {
  const plan = schedule({ passedAt: [null, 700, null], slats: 8 })
  assert.equal(plan.shownAt[1], 700)
  assert.equal(plan.shownAt[0], null)
})

test('全部通过后停 holdMs，且总时长不少于 minTotalMs；之后才退场', () => {
  const fast = schedule({ passedAt: [50, 60, 70], slats: 8 })
  assert.equal(fast.readyAt, T.minTotalMs, '都很快：用最短总时长')
  const slow = schedule({ passedAt: [600, 1500, 2600], slats: 8 })
  assert.equal(slow.readyAt, 2600 + T.holdMs, '最后一行亮起后再停一会儿')
  assert.equal(slow.leaveAt, slow.readyAt)
  assert.equal(slow.timedOut, false)
})

test('硬上限：就算检查拖得很久，也必定在 maxTotalMs 退场，不会卡住 DSH', () => {
  const plan = schedule({ passedAt: [100, 200, 9000], slats: 8 })
  assert.equal(plan.leaveAt, T.maxTotalMs)
  assert.equal(plan.timedOut, true, '上限之后才通过的检查，不能事后把"超时"改写成"没超时"')
  assert.equal(plan.shownAt[2], null)
  assert.equal(lineStatus(plan, 2, plan.doneAt), 'timeout')
  // 退场过程中（上限之后、结束之前）才通过的检查，同样不改变结果。
  const late = schedule({ passedAt: [100, 200, T.maxTotalMs + 400], slats: 8 })
  assert.equal(late.timedOut, true)
})

test('跳过：立即退场，不是超时', () => {
  const plan = schedule({ passedAt: [null, null, null], skippedAt: 300, slats: 8 })
  assert.equal(plan.leaveAt, 300)
  assert.equal(plan.skipped, true)
  assert.equal(plan.timedOut, false)
  assert.equal(lineStatus(plan, 0, 300), 'skipped')
  assert.equal(phaseAt(plan, 300), 'leave', '进场期间跳过，退场优先')
})

test('结束时间 = 退场时间 + 文字淡出 + 玻璃条依次上滑（错峰）+ 上滑时长', () => {
  const plan = schedule({ passedAt: [50, 60, 70], slats: 8 })
  assert.equal(plan.doneAt, plan.leaveAt + T.textFadeMs + 7 * T.slatStaggerMs + T.slatLiftMs)
  assert.ok(plan.doneAt < 3200, `快速路径总时长应在约 3 秒内，实际 ${plan.doneAt}ms`)
})

test('阶段：进场 → 检查 → 退场 → 结束', () => {
  const plan = schedule({ passedAt: [50, 60, 70], slats: 8 })
  assert.equal(phaseAt(plan, 0), 'enter')
  assert.equal(phaseAt(plan, T.enterMs), 'check')
  assert.equal(phaseAt(plan, plan.leaveAt), 'leave')
  assert.equal(phaseAt(plan, plan.doneAt), 'done')
})

test('进度按真实亮起的行数计算，下一个需要渲染的时间点不会漏', () => {
  const plan = schedule({ passedAt: [50, 60, null], slats: 8 })
  assert.equal(progressAt(plan, 100), 0)
  assert.ok(Math.abs(progressAt(plan, plan.shownAt[0]) - 1 / 3) < 1e-9)
  assert.ok(Math.abs(progressAt(plan, plan.shownAt[1]) - 2 / 3) < 1e-9)
  assert.equal(nextDueAt(plan, 0), T.enterMs)
  assert.equal(nextDueAt(plan, plan.doneAt), null)
  assert.equal(progressAt(schedule({ passedAt: [], slats: 4 }), T.enterMs), 1, '没有检查项时按进场是否结束算')
})

test('是否播放：减少动态效果、用户关闭、已经播放过，都不播放', () => {
  assert.equal(shouldPlay({ disabledByUser: false, reducedMotion: false, alreadyPlayed: false }), true)
  assert.equal(shouldPlay({ disabledByUser: true, reducedMotion: false, alreadyPlayed: false }), false)
  assert.equal(shouldPlay({ disabledByUser: false, reducedMotion: true, alreadyPlayed: false }), false)
  assert.equal(shouldPlay({ disabledByUser: false, reducedMotion: false, alreadyPlayed: true }), false)
})

test('玻璃条数量：窄屏少、宽屏多，并且有上下限', () => {
  assert.equal(slatCount(375), 4)
  assert.equal(slatCount(800), 6)
  assert.equal(slatCount(1440), 8)
  assert.equal(slatCount(9000), 12)
  assert.equal(slatCount(Number.NaN), 6)
})

test('显示名称走统一配置，默认 Chengmeng，不合格的值回退默认', () => {
  assert.equal(agentDisplayName({}), DEFAULT_AGENT_NAME)
  assert.equal(agentDisplayName({ __CHENGMENG_CONFIG__: { agentDisplayName: '  橙梦  ' } }), '橙梦')
  assert.equal(agentDisplayName({ __CHENGMENG_CONFIG__: { agentDisplayName: '' } }), DEFAULT_AGENT_NAME)
  assert.equal(agentDisplayName({ __CHENGMENG_CONFIG__: { agentDisplayName: 'x'.repeat(25) } }), DEFAULT_AGENT_NAME)
  assert.equal(agentDisplayName({ __CHENGMENG_CONFIG__: { agentDisplayName: 42 } }), DEFAULT_AGENT_NAME)
})

test('读设置永远不抛：隐私模式下 localStorage 会抛异常', () => {
  const throwing = { getItem: () => { throw new Error('denied') } }
  assert.equal(readSetting(throwing, 'k'), null)
  assert.equal(startupDisabled(throwing), false)
  assert.equal(startupDisabled({ getItem: () => 'off' }), true)
  assert.equal(startupDisabled(null), false)
})

test('样式：没有任何循环动画；所有过渡只用弹簧 token；遵守减少动态效果；不挡住键盘字符', () => {
  const css = startupCSS()
  assert.doesNotMatch(css, /infinite/, '启动动画只有状态驱动的运动，没有循环')
  assert.doesNotMatch(css, /@keyframes/)
  const transitions = [...css.matchAll(/(?<![-\w])transition:([^;}]+)/g)].map((m) => m[1])
  assert.ok(transitions.length >= 10)
  for (const value of transitions) {
    if (value === 'none!important') continue // 减少动态效果规则：关闭过渡本身
    for (const part of value.split(',')) assert.match(part, /var\(--cm-spring-(fade|push|travel)(-ms)?\)/, `过渡没有使用弹簧 token：${part}`)
  }
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*transition:none!important/)
  // 回弹只给几何：颜色、透明度用 fade。
  assert.doesNotMatch(css, /color [^;]*var\(--cm-spring-(push|travel)/)
})

test('源码静态检查：没有外联、没有 console.log、没有 Notification、没有 innerHTML', () => {
  for (const file of ['startup.js', 'schedule.js', 'config.js', 'client-entry.js']) {
    let source = readFileSync(new URL(`../../plugins/startup-animation/src/${file}`, import.meta.url), 'utf8')
    if (file === 'client-entry.js') {
      assert.match(source, /fetch\('\/chengmeng-memory\/status', \{ credentials: 'same-origin', cache: 'no-store', signal \}\)/)
      source = source.replace("fetch('/chengmeng-memory/status',", 'readLocalMemoryStatus(')
    }
    for (const banned of [/\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /console\.log/, /\bNotification\b/, /innerHTML/, /\beval\(/, /new Function\(/]) {
      assert.doesNotMatch(source, banned, `${file} 含有 ${banned}`)
    }
  }
})
