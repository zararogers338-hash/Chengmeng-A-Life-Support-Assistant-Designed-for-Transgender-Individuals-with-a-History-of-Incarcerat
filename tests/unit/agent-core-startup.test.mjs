import test from 'node:test'
import assert from 'node:assert/strict'
import { mountStartup } from '../../plugins/startup-animation/src/startup.js'
import { slatCount } from '../../plugins/startup-animation/src/schedule.js'
import { hasMemoryModule, memoryStatusReady } from '../../plugins/startup-animation/src/config.js'

test('启动动画接入回归：只检查已安装的记忆模块，关闭记忆仍可就绪', () => {
  assert.equal(hasMemoryModule({}), false)
  assert.equal(hasMemoryModule({ entries: [{ id: '@chengmeng/dsh-memory-consent' }] }), true)
  assert.equal(memoryStatusReady({ ok: true, enabled: false }), true)
  assert.equal(memoryStatusReady({ ok: false, error: 'unauthorized' }), false)
  assert.equal(memoryStatusReady({ ok: true }), false)
})

// Reproduces the real narrow-window failure: no wallpaper => null slat boxes.
// Exercise the actual mount path, rather than only testing the count helper.
function fakeDocument(width) {
  const doc = { addEventListener() {}, removeEventListener() {}, defaultView: {
    innerWidth: width, performance: { now: () => 0 }, AbortController,
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  } }
  doc.createElement = () => ({ ownerDocument: doc, clientWidth: width,
    children: [], dataset: {}, style: { setProperty() {} },
    setAttribute() {}, addEventListener() {}, remove() { this.removed = true },
    append(...items) { this.children.push(...items) }, appendChild(item) { this.children.push(item) },
  })
  return doc
}

test('启动动画接入回归：窄屏或关闭壁纸时可挂载、覆盖全宽并正常释放', () => {
  for (const width of [375, 615, 900, 1440]) {
    const host = fakeDocument(width).createElement('div')
    let done = 0
    const controller = mountStartup(host, { name: '澄梦', slats: null, checks: [], onDone: () => done++ })
    const slats = controller.root.children.filter(node => node.className === 'cm-boot__slat')
    assert.equal(slats.length, slatCount(width))
    assert.equal(slats[0].style.left, '0.0000%')
    const last = slats.at(-1)
    const end = parseFloat(last.style.left) + parseFloat(last.style.width.slice(5))
    assert(Math.abs(end - 100) < 0.001)
    assert(slats.every(node => !/NaN|undefined/.test(node.style.width)))
    controller.skip()
    controller.dispose()
    controller.dispose()
    assert.equal(done, 1)
    assert.equal(controller.root.removed, true)
  }
})
