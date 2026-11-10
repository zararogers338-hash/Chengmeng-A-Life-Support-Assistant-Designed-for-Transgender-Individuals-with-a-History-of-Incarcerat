import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseGlassTier, displacementMapPixels, lensCSS, RING_PERIOD } from '../../plugins/pastel-theme/src/glass.js'
import { springCSSVariables } from '../../plugins/pastel-theme/src/springs.js'

test('玻璃分级：无障碍偏好一律降为 Off，非 Chromium 最高到 Standard', () => {
  const base = { override: null, reducedTransparency: false, highContrast: false, forcedColors: false, chromium: true }
  assert.equal(chooseGlassTier(base), 'rich')
  assert.equal(chooseGlassTier({ ...base, chromium: false }), 'standard')
  assert.equal(chooseGlassTier({ ...base, override: 'rich', chromium: false }), 'standard')
  assert.equal(chooseGlassTier({ ...base, override: 'standard' }), 'standard')
  for (const flag of ['reducedTransparency', 'highContrast', 'forcedColors']) {
    assert.equal(chooseGlassTier({ ...base, [flag]: true }), 'off', flag)
  }
  assert.equal(chooseGlassTier({ ...base, override: 'off' }), 'off')
})

test('位移贴图：中心不偏移，边缘一圈向中心方向采样', () => {
  const w = 200, h = 80
  const px = displacementMapPixels(w, h, 28, 22)
  const at = (x, y) => Array.from(px.slice((y * w + x) * 4, (y * w + x) * 4 + 4))
  assert.deepEqual(at(100, 40), [128, 128, 128, 255])
  const [rl] = at(1, 40)
  const [rr] = at(198, 40)
  assert.ok(rl > 200, `左边缘应向右采样，R=${rl}`)
  assert.ok(rr < 56, `右边缘应向左采样，R=${rr}`)
  const [, gt] = at(100, 1)
  const [, gb] = at(100, 78)
  assert.ok(gt > 200 && gb < 56, `上下边缘应向中心采样，G=${gt}/${gb}`)
  for (let i = 3; i < px.length; i += 4) assert.equal(px[i], 255)
})

test('透镜样式：玻璃在文字下方、不拦截点击；卡片底色只在本作用域重新绑定', () => {
  const css = lensCSS(springCSSVariables())
  assert.match(css, /\.cm-lens\{[^}]*pointer-events:none/)
  assert.match(css, /\.cm-glass\{[^}]*z-index:-1/)
  assert.match(css, /\[data-composer-card\]:has\([^)]*\)[^{]*\{--dsw-specific-input-major:transparent\}/)
  assert.doesNotMatch(css, /^:root|body\s*\{/m)
})

test('透明度、颜色、模糊的过渡只用 fade（bounce 为 0）', () => {
  const css = lensCSS(springCSSVariables())
  const transitions = [...css.matchAll(/transition:([^;}]+)/g)].map((m) => m[1])
  assert.ok(transitions.length >= 2)
  for (const t of transitions) assert.match(t, /var\(--cm-spring-fade-ms\) var\(--cm-spring-fade\)/)
})

test('边缘流光：无级、遵守减少动态效果、周期不少于 12 秒', () => {
  const css = lensCSS(springCSSVariables())
  assert.match(css, /@property --cm-ring-angle\{syntax:"<angle>"/)
  assert.match(css, /conic-gradient\(from var\(--cm-ring-angle\) in oklch/)
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.cm-ring::before,\.cm-ring::after\{animation:none/)
  assert.ok(RING_PERIOD >= 12)
})
