import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CYCLE_LIGHT, DESKTOP_MIN_WIDTH, DRIFT, FIELD_HEIGHT, FIELD_TOP, fieldBackground,
  fluteCount, fluteOffsets, pastelTokens, wallpaperCSS,
} from '../../plugins/pastel-theme/src/refraction.js'
import * as refraction from '../../plugins/pastel-theme/src/refraction.js'

test('窄屏不显示壁纸，桌面端玻璃条数量在 6 到 12 之间', () => {
  assert.equal(fluteCount(375), 0)
  assert.equal(fluteCount(DESKTOP_MIN_WIDTH - 1), 0)
  assert.equal(fluteCount(Number.NaN), 0)
  for (const w of [1024, 1280, 1440, 1920, 2560, 5120]) {
    const n = fluteCount(w)
    assert.ok(n >= 6 && n <= 12, `${w}px -> ${n}`)
  }
})

test('玻璃条错位是确定的，并且整体从左到右上移', () => {
  assert.deepEqual(fluteOffsets(8), fluteOffsets(8))
  const o = fluteOffsets(10)
  assert.equal(o.length, 10)
  assert.ok(o.at(-1) < o[0])
})

test('错位加漂移后，色场仍然覆盖整个视口', () => {
  // translateY 和 translate 的百分比都以色场自身高度为基准。
  for (const n of [6, 8, 10, 12]) {
    for (const dy of fluteOffsets(n)) {
      const top = -FIELD_TOP + ((dy + DRIFT) * FIELD_HEIGHT) / 100
      const bottom = FIELD_HEIGHT - FIELD_TOP + ((dy - DRIFT) * FIELD_HEIGHT) / 100
      assert.ok(top <= 0, `n=${n} dy=${dy} top=${top}`)
      assert.ok(bottom >= 100, `n=${n} dy=${dy} bottom=${bottom}`)
    }
  }
})

test('色带首尾同色，重复时没有接缝，用 OKLCH 插值', () => {
  assert.equal(CYCLE_LIGHT[0][0], 0)
  assert.equal(CYCLE_LIGHT.at(-1)[0], 100)
  assert.equal(CYCLE_LIGHT[0][1], CYCLE_LIGHT.at(-1)[1])
  assert.match(fieldBackground(), /^repeating-linear-gradient\(180deg in oklch, /)
})

test('只有一套粉白蓝色带：没有深色版本，任何参数都得到同一张壁纸', () => {
  assert.equal('CYCLE_DARK' in refraction, false)
  assert.equal(fieldBackground('dark'), fieldBackground('light'))
  assert.doesNotMatch(wallpaperCSS(), /data-scheme=dark/)
  // 色带里只有青、天蓝、冰白、纸白、浅粉、粉、玫瑰：用 sRGB 判断，没有"蓝分量最高且红分量也高"的紫色停靠点。
  for (const [, hex] of CYCLE_LIGHT) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const purple = b > g + 30 && r > g + 30
    assert.equal(purple, false, `${hex} 不应是紫色`)
  }
})

test('token 覆盖层每一项都同时给出深色和浅色的值（overrideTokens 的硬性要求）', () => {
  for (const wallpaper of [true, false]) {
    for (const [name, modes] of Object.entries(pastelTokens({ wallpaper }))) {
      assert.match(name, /^--dsw-/)
      assert.equal(typeof modes.light, 'string')
      assert.equal(typeof modes.dark, 'string')
    }
  }
  assert.equal(pastelTokens({ wallpaper: true })['--dsw-alias-bg-base'].light, 'transparent')
  assert.notEqual(pastelTokens({ wallpaper: false })['--dsw-alias-bg-base'].light, 'transparent')
})

test('其他页面统一：设置面板、卡片、浮层、菜单、遮罩都用 Pastel 纸白；有壁纸时半透明，窄屏时不透明', async () => {
  const { surfaceTokens } = await import('../../plugins/pastel-theme/src/refraction.js')
  const names = ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-overlay', '--dsw-alias-bg-mask-1', '--dsw-specific-sidebar-nav-item-active']
  const glass = surfaceTokens(true)
  const solid = surfaceTokens(false)
  for (const name of names) {
    assert.ok(glass[name] && solid[name], name)
    assert.equal(glass[name].light, glass[name].dark, `${name}：Pastel 只有浅色，两个值相同`)
  }
  assert.match(glass['--dsw-alias-bg-layer-2'].light, /\/ \.\d+\)$/, '有壁纸时设置面板半透明')
  assert.match(solid['--dsw-alias-bg-layer-2'].light, /^#[0-9A-F]{6}$/i, '窄屏时设置面板不透明')
  assert.doesNotMatch(glass['--dsw-alias-bg-mask-1'].light, /rgb\(0 0 0|rgba\(0, 0, 0/, '遮罩不是黑色')
  assert.match(glass['--dsw-mask-blur'].light, /blur\(\d+px\)/, '半透明面板后面必须是磨砂，不能透出对话内容')
  // 合并进 pastelTokens
  assert.ok(pastelTokens({ wallpaper: true })['--dsw-alias-bg-layer-2'])
})

test('侧栏透明，由壁纸里的磨砂层托底，磨砂在侧栏边缘之后渐隐', () => {
  assert.equal(pastelTokens({ wallpaper: true })['--dsw-specific-sidebar-fill'].light, 'transparent')
  const css = wallpaperCSS()
  assert.match(css, /\.cm-wp__frost\{[^}]*width:calc\(var\(--cm-side-w\) \+ var\(--cm-frost-fade\)\)/)
  assert.match(css, /\.cm-wp__frost\{[^}]*mask-image:linear-gradient\(90deg,#000 0,#000 calc\(100% - 2 \* var\(--cm-frost-fade\)\),transparent\)/)
})

test('样式表遵守减少动态效果，并且只在桌面端显示壁纸', () => {
  const css = wallpaperCSS()
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.cm-wp__field\{animation:none\}/)
  assert.match(css, new RegExp(`max-width:${DESKTOP_MIN_WIDTH - 0.02}px\\)\\{\\.cm-wp\\{display:none\\}`))
  assert.match(css, /pointer-events:none/)
})
