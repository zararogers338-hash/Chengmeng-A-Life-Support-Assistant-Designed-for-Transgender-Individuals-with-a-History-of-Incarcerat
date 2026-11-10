/**
 * 输入框液态玻璃。方法来自 liquid-glass-motion Skill：
 * - 玻璃分三级：Off（不透明）、Standard（磨砂：模糊加染色加描边，没有折射）、Rich（边缘折射）。
 *   高对比度、减少透明度、强制颜色模式下一律降为 Off。
 * - 光学层、内容、交互三者分开：玻璃画在文字下方，不拦截点击，也不改变布局。
 * - 透明度、颜色、模糊的变化只用 bounce 为 0 的 fade 弹簧；高光位置属于几何，用 follow 弹簧追随指针。
 *
 * Rich 档用 SVG feDisplacementMap 作为 backdrop-filter：边缘一圈按圆角矩形的距离场把背景向内折射，
 * 中心保持清透。这是 Chromium 才有的能力（DSH 桌面版是 Electron），其他浏览器自动降为 Standard。
 * 它是对液态玻璃的视觉模拟，不是 Apple 的原生材质。
 *
 * 构建脚本会把本文件内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`。
 */

export const GLASS_TIERS = Object.freeze(['off', 'standard', 'rich'])

/** 输入框边缘流光转一周的秒数。属于环境光，不属于形变（见 docs/DESIGN.md）。 */
export const RING_PERIOD = 14

/** 折射斜面的宽度和最大位移（像素）。 */
export const LENS_BEVEL = 28
export const LENS_SCALE = 64

export function chooseGlassTier({ override, reducedTransparency, highContrast, forcedColors, chromium }) {
  if (override === 'off' || reducedTransparency || highContrast || forcedColors) return 'off'
  if (override === 'standard' || !chromium) return 'standard'
  return 'rich'
}

/**
 * 生成位移贴图的 RGBA 像素：R、G 两个通道编码采样偏移，128 表示不偏移。
 * 在圆角矩形内、离边缘不到 bevel 的地方，沿法线向中心方向采样，并且越靠边偏得越多（二次曲线）。
 * 只向内采样，因为 backdrop 在元素边界之外取不到像素。
 */
export function displacementMapPixels(width, height, radius, bevel) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const data = new Uint8ClampedArray(w * h * 4)
  const hx = w / 2
  const hy = h / 2
  const r = Math.max(0, Math.min(radius, hx, hy))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hx
      const py = y + 0.5 - hy
      const qx = Math.abs(px) - (hx - r)
      const qy = Math.abs(py) - (hy - r)
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
      const depth = -sd
      let nx = 0
      let ny = 0
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1
        nx = (qx / len) * Math.sign(px)
        ny = (qy / len) * Math.sign(py)
      } else if (qx > qy) {
        nx = Math.sign(px)
      } else {
        ny = Math.sign(py)
      }
      const t = depth < 0 ? 0 : Math.min(1, Math.max(0, 1 - depth / bevel))
      const mag = t * t
      const i = (y * w + x) * 4
      data[i] = Math.round(128 - nx * mag * 127)
      data[i + 1] = Math.round(128 - ny * mag * 127)
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  return data
}

/** 把位移贴图画到 canvas 上并导出 data URL。按半分辨率生成，交给 feImage 拉伸，开销很小。 */
export function displacementMapURL(doc, width, height, radius) {
  const scale = 0.5
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = doc.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d')
  const image = context.createImageData(w, h)
  image.data.set(displacementMapPixels(w, h, radius * scale, LENS_BEVEL * scale))
  context.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * 透镜样式：.cm-lens 是贴合输入框卡片的定位容器；.cm-glass 是玻璃本体，z-index:-1，画在文字下方；
 * .cm-ring 是边缘流光。所有过渡都读取弹簧 token 生成的 CSS 变量。
 * 卡片自己的底色只在 [data-composer-card] 这个作用域里重新绑定为透明，其他使用同一 token 的组件不受影响。
 */
export function lensCSS(springVariables) {
  const flow = 'conic-gradient(from var(--cm-ring-angle) in oklch, #1CCBFC, #DCEEF8 16%, #FBA8B8 36%, #F88AA2 48%, #C3BDDB 64%, #7FD6F5 82%, #1CCBFC)'
  const mask = 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)'
  const fade = 'var(--cm-spring-fade-ms) var(--cm-spring-fade)'
  return `
@property --cm-ring-angle{syntax:"<angle>";inherits:false;initial-value:0deg}
[data-composer-card]:has(> [data-composer-overlay] .cm-lens[data-tier=standard]),
[data-composer-card]:has(> [data-composer-overlay] .cm-lens[data-tier=rich]){--dsw-specific-input-major:transparent}
.cm-lens{${springVariables};position:absolute;left:0;right:0;top:0;height:var(--cm-ring-h,0px);pointer-events:none;--cm-radius:var(--dsw-radius-panel,28px);
  --cm-glass-tint:rgb(128 134 150 / .12);--cm-glass-hi:rgb(255 255 255 / .85);--cm-glass-lo:rgb(255 255 255 / .22);--cm-glass-edge:rgb(255 255 255 / .38);--cm-glass-depth:rgb(255 255 255 / .14);--cm-spec:rgb(255 255 255 / .42);
  --cm-glass-float:0 22px 44px -18px rgb(40 46 70 / .32),0 6px 14px -6px rgb(40 46 70 / .14)}
.cm-glass{position:absolute;inset:0;z-index:-1;border-radius:var(--cm-radius);background-color:var(--cm-glass-tint);-webkit-backdrop-filter:var(--cm-glass-filter);backdrop-filter:var(--cm-glass-filter);box-shadow:var(--cm-glass-float),inset 0 1px 0 var(--cm-glass-hi),inset 0 -1px 0 var(--cm-glass-lo),inset 0 0 0 1px var(--cm-glass-edge),inset 0 0 22px var(--cm-glass-depth)}
.cm-lens[data-tier=standard] .cm-glass{--cm-glass-filter:blur(12px) saturate(1.3) brightness(.98)}
.cm-lens[data-tier=rich] .cm-glass{--cm-glass-filter:var(--cm-glass-url) blur(2px) saturate(1.25) brightness(.98)}
.cm-glass::after{content:"";position:absolute;inset:0;border-radius:inherit;background:radial-gradient(260px 130px at var(--cm-spec-x,28%) var(--cm-spec-y,-12%),var(--cm-spec),transparent 72%);opacity:.55;transition:opacity ${fade}}
.cm-ring{position:absolute;inset:0;border-radius:var(--cm-radius)}
.cm-ring::before,.cm-ring::after{content:"";position:absolute;background:${flow};-webkit-mask:${mask};-webkit-mask-composite:xor;mask:${mask};mask-composite:exclude;animation:cm-ring-flow ${RING_PERIOD}s linear infinite;transition:opacity ${fade}}
.cm-ring::before{inset:-1.5px;padding:1.5px;border-radius:calc(var(--cm-radius) + 1.5px);opacity:.55}
.cm-ring::after{inset:-18px;padding:18px;border-radius:calc(var(--cm-radius) + 18px);filter:blur(16px);opacity:.26}
[data-composer-card]:focus-within .cm-glass::after{opacity:1}
[data-composer-card]:focus-within .cm-ring::before{opacity:1}
[data-composer-card]:focus-within .cm-ring::after{opacity:.6}
@keyframes cm-ring-flow{to{--cm-ring-angle:360deg}}
@media (prefers-reduced-motion:reduce){.cm-ring::before,.cm-ring::after{animation:none;--cm-ring-angle:200deg}}
`
}
