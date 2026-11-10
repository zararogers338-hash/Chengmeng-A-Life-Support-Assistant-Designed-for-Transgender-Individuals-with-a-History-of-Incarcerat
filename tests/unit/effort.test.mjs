import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  band, glyphLevel, nearestStop, projectStop, resolveReasoning, rubberBand, stopPositions,
} from '../../plugins/pastel-theme/src/effort.js'

test('橡皮筋：边缘斜率约 0.55，越拉越硬，永远不超过上限', () => {
  assert.equal(rubberBand(0, 30), 0)
  assert.ok(Math.abs(rubberBand(0.01, 30) / 0.01 - 0.55) < 0.01)
  assert.ok(rubberBand(10000, 30) < 30)
  assert.ok(rubberBand(-10000, 30) > -30)
  assert.equal(band(50, 20, 200, 30), 50)
  assert.ok(band(250, 20, 200, 30) < 230)
})

test('档位均匀分布；滑块在两端时和轨道圆头完全重合', () => {
  const p = stopPositions(4, 272, 40)
  assert.equal(p.length, 4)
  assert.equal(p[0] - 20, 0, '最左档：滑块左缘贴住轨道左端')
  assert.equal(p[3] + 20, 272, '最右档：滑块右缘贴住轨道右端')
  assert.ok(Math.abs((p[1] - p[0]) - (p[2] - p[1])) < 1e-9)
})

test('填充收在滑块下面，不会在白色滑块旁边露出颜色', async () => {
  const { fillReach } = await import('../../plugins/pastel-theme/src/effort.js')
  const r = 20
  assert.ok(fillReach(40) < r, '填充右端在滑块右缘以内')
  assert.ok(fillReach(40) > 0, '填充仍然延伸到滑块下方，不会在滑块左侧断开')
})

test('松手落点看手指加速度投射，最多越过一格', () => {
  const p = stopPositions(5, 400, 40)
  assert.equal(projectStop(p, p[2], 0), 2)
  assert.equal(projectStop(p, p[2] + 10, 3000), 3, '快速甩动最多多走一格')
  assert.equal(projectStop(p, p[2] - 10, -3000), 1)
  assert.equal(projectStop(p, p[0] - 50, -5000), 0, '不会越过端点')
  assert.equal(nearestStop(p, (p[1] + p[2]) / 2 + 1), 2)
})

test('从 DSH 模型目录快照解析档位：默认档位、待提交档位、无元数据时隐藏', () => {
  const groups = [{ id: 'deepseek', name: 'DeepSeek', models: [
    { id: 'v4', name: 'DeepSeek V4', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }], defaultEffort: 'medium' } },
    { id: 'chat', name: 'Chat' },
  ] }]
  const base = { groups, status: 'ready', pending: null }
  const r1 = resolveReasoning({ ...base, current: { provider: 'deepseek', model: 'v4' } })
  assert.equal(r1.index, 1)
  assert.equal(r1.modelName, 'DeepSeek V4')
  const r2 = resolveReasoning({ ...base, current: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' } })
  assert.equal(r2.index, 2)
  const r3 = resolveReasoning({ ...base, status: 'selecting', current: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }, pending: { provider: 'deepseek', model: 'v4', reasoningEffort: 'low' } })
  assert.equal(r3.index, 0)
  assert.equal(r3.pending, true)
  assert.equal(resolveReasoning({ ...base, current: { provider: 'deepseek', model: 'chat' } }), null)
  assert.equal(resolveReasoning({ ...base, current: null }), null)
  assert.equal(resolveReasoning({ ...base, current: { provider: 'gone', model: 'v4' } }), null)
})

test('粒子流足够快：最慢的粒子也能在 2 秒内划过整条轨道', async () => {
  const { seedSparks, SPARK_MIN_SPEED } = await import('../../plugins/pastel-theme/src/effort.js')
  assert.ok(SPARK_MIN_SPEED >= 136, '272px 的轨道 2 秒内走完')
  for (const p of seedSparks(40, 272, 40)) assert.ok(p.v >= SPARK_MIN_SPEED)
})

test('粒子：分布确定且落在轨道内；流动时向左（向后）移动，流出左端后从右端重新进入', async () => {
  const { seedSparks, stepSparks } = await import('../../plugins/pastel-theme/src/effort.js')
  const a = seedSparks(30, 272, 40)
  assert.deepEqual(a, seedSparks(30, 272, 40))
  for (const p of a) {
    assert.ok(p.x >= 0 && p.x <= 272 && p.y >= 5 && p.y <= 35)
    assert.ok(p.v > 0)
  }
  const before = a.map((p) => p.x)
  stepSparks(a, 0.1, 272, 40, () => 0.5)
  a.forEach((p, i) => assert.ok(p.x < before[i] || p.x >= 272, '每颗粒子都向左移动或已从右端重新进入'))
  const edge = [{ x: -5, y: 20, r: 1, a: 1, v: 50 }]
  stepSparks(edge, 0.016, 272, 40, () => 0)
  assert.ok(edge[0].x >= 272, '流出左端后从右端重新进入')
})

test('滑动条配色：未填充轨道为中性灰，蓝色实心填充，最高档紫色渐变；没有旧的粉蓝折光轨道', async () => {
  const { effortCSS } = await import('../../plugins/pastel-theme/src/effort.js')
  const css = effortCSS()
  assert.match(css, /\.cm-effort-fill>\.cm-on\{background:#3B82F6\}/)
  assert.match(css, /\.cm-effort-pop\[data-tier=max\] \.cm-effort-fill>\.cm-max\{opacity:1\}/)
  assert.match(css, /\.cm-effort-pop\[data-tier=off\] \.cm-effort-fill\{opacity:0\}/)
  assert.doesNotMatch(css, /cm-effort-rest|#F88AA2/)
})

test('hidden 属性不会被组件自己的 display 覆盖（没有档位时胶囊必须真的隐藏）', async () => {
  const { effortCSS } = await import('../../plugins/pastel-theme/src/effort.js')
  const css = effortCSS()
  assert.match(css, /\.cm-effort-chip\[hidden\]\{display:none\}/)
  assert.match(css, /\.cm-effort-reset\[hidden\]\{[^}]*visibility:hidden/)
})

test('强度竖条：没有 Off 时最低亮 1 根、最高亮 3 根', () => {
  assert.equal(glyphLevel(0, 4), 1)
  assert.equal(glyphLevel(3, 4), 3)
  assert.equal(glyphLevel(0, 1), 3)
})

test('DeepSeek-V4.1-Flash 的真实档位 Off / Low / High / Max：Off 无光，最高档以下一律蓝色，最高档紫色', async () => {
  const { effortTier, effortTint, isOffEffort } = await import('../../plugins/pastel-theme/src/effort.js')
  const efforts = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }]
  assert.deepEqual(efforts.map((_, i) => glyphLevel(i, efforts)), [0, 1, 2, 3])
  assert.equal(isOffEffort(efforts[0]), true)
  assert.equal(isOffEffort(efforts[1]), false)
  assert.deepEqual(efforts.map((_, i) => effortTier(i, efforts)), ['off', 'on', 'on', 'max'])
  assert.equal(effortTint('on', 'light'), effortTint('on', 'light'))
  assert.notEqual(effortTint('on', 'light'), effortTint('max', 'light'))
  assert.equal(effortTint('off', 'light'), '#6B7088')
  assert.equal(effortTint('max', 'dark'), '#A98BFF')
  const groups = [{ id: 'ds', name: 'DeepSeek', models: [{ id: 'flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts, defaultEffort: 'high' } }] }]
  const r = resolveReasoning({ groups, status: 'ready', pending: null, current: { provider: 'ds', model: 'flash' } })
  assert.equal(r.efforts[r.index].name, 'High')
})
