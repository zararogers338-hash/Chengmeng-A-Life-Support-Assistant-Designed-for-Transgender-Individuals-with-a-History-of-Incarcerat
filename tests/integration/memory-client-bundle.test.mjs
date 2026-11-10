/**
 * 客户端 bundle 冒烟测试。
 *
 * 不依赖真实浏览器、不启动 DSH：用 node:vm 提供最小的 window/document，
 * 验证 lib/client.js 能被模块加载器接住、factory 和 apply 的行为正确、
 * 卸载后样式标签与槽位注册都被撤销、没有 document 时 apply 不抛异常。
 *
 * 构建产物不手写：先运行 node plugins/memory-consent/scripts/build.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundlePath = join(root, 'plugins', 'memory-consent', 'lib', 'client.js')
const EXPECTED_ID = '@chengmeng/dsh-memory-consent'

let cachedSource = null
function bundleSource() {
  if (cachedSource === null) cachedSource = readFileSync(bundlePath, 'utf8')
  return cachedSource
}

/** 最小 document：createElement/head.appendChild/removeChild，节点有 setAttribute/remove。 */
function createFakeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
      return node
    },
    removeChild(node) {
      const index = this.children.indexOf(node)
      if (index >= 0) this.children.splice(index, 1)
      return node
    },
  }
  return {
    head,
    body: head,
    visibilityState: 'visible',
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attributes: {},
        style: {},
        children: [],
        textContent: '',
        removed: false,
        setAttribute(name, value) { this.attributes[name] = String(value) },
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null },
        appendChild(child) { this.children.push(child); return child },
        remove() {
          const index = head.children.indexOf(this)
          if (index >= 0) head.children.splice(index, 1)
          this.removed = true
        },
      }
    },
    querySelector() { return null },
  }
}

/**
 * 执行 bundle 文本。withDocument 为 false 时沙箱里没有 document，
 * 用来验证 apply 在没有浏览器环境时不抛异常。
 */
function loadBundle({ withDocument = true } = {}) {
  let captured = null
  const document = withDocument ? createFakeDocument() : undefined
  const windowObject = {
    __ModuleLoader__: {
      load(entry) { captured = entry },
    },
  }
  const sandbox = { window: windowObject }
  if (document) sandbox.document = document
  vm.createContext(sandbox)
  vm.runInContext(bundleSource(), sandbox, { filename: 'client.js' })
  return { entry: captured, document, window: windowObject }
}

/** 假 React：只用于证明 factory 顶层不会调用 require。 */
function fakeReact() {
  return {
    createElement: () => null,
    Component: class FakeComponent {},
  }
}

test('构建产物存在，且是 window.__ModuleLoader__.load 格式', () => {
  assert.ok(existsSync(bundlePath), '缺少 plugins/memory-consent/lib/client.js，先运行构建脚本')
  const source = bundleSource()
  assert.ok(source.startsWith('window.__ModuleLoader__.load('), 'bundle 必须由模块加载器入口开始')
  assert.match(source, /id:\s*"@chengmeng\/dsh-memory-consent"/)
  // factory 末尾必须导出宿主约定的三样东西
  assert.match(source, /exports\.name = name;/)
  assert.match(source, /exports\.inject = inject;/)
  assert.match(source, /exports\.apply = apply;/)
  // 构建产物确实包含各模块（防止误用旧的或空的文件）
  for (const marker of ['ComposerDock', 'SettingsSection', 'createMemoryStore', 'memoryCSS', 'springCSSVariables']) {
    assert.ok(source.includes(marker), `bundle 缺少模块符号 ${marker}`)
  }
})

test('客户端 bundle 只请求同源相对路径，不含外部地址与禁用 API', () => {
  const source = bundleSource()
  assert.doesNotMatch(source, /https?:\/\//i, '客户端源码里不能出现任何外部地址')
  assert.doesNotMatch(source, /\bNotification\b/, '不允许使用 Notification API')
  assert.doesNotMatch(source, /\bconsole\.log\s*\(/, '不允许 console.log')
  assert.doesNotMatch(source, /(^|[^\w.$])eval\s*\(/m, '不允许 eval')
  assert.doesNotMatch(source, /\bimport\s*\(/, '不允许动态 import')
  // 路由前缀与各端点都在
  assert.ok(source.includes('/chengmeng-memory'), '缺少路由前缀 /chengmeng-memory')
  for (const path of ['/status', '/pending', '/memories', '/confirm', '/reject', '/update', '/delete', '/delete-all', '/settings', '/rebuild-index', '/export?format=']) {
    assert.ok(source.includes(path), `bundle 缺少路由路径 ${path}`)
  }
  // 不把记忆内容写进 localStorage
  assert.ok(!source.includes('localStorage'), '记忆模块不应使用 localStorage')
})

test('factory 顶层不 require，导出 name / inject / apply', () => {
  const { entry } = loadBundle()
  assert.ok(entry, 'bundle 没有调用 window.__ModuleLoader__.load')
  assert.equal(entry.id, EXPECTED_ID)
  assert.equal(typeof entry.factory, 'function')

  const requireCalls = []
  const exports = entry.factory((id) => {
    requireCalls.push(id)
    return fakeReact()
  })
  assert.deepEqual(requireCalls, [], 'factory 顶层不应调用 require，React 只能在组件函数内部取')
  assert.equal(exports.name, EXPECTED_ID)
  assert.ok(Array.isArray(exports.inject), 'inject 必须是数组')
  assert.ok(exports.inject.includes('slots'), 'inject 必须包含插件依赖的服务 slots')
  assert.equal(typeof exports.apply, 'function')
})

test('apply 注册样式与两个槽位，卸载后全部撤销', () => {
  const { entry, document } = loadBundle()
  const exports = entry.factory(() => fakeReact())

  const effects = []
  const registrations = []
  const ctx = {
    effect(fn, label) {
      // 真实 cordis 的 effect 会立即执行回调并收集返回值作为 disposer
      effects.push({ label, dispose: fn() })
    },
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(config, Component) {
        const registration = { config, Component, disposed: false }
        registrations.push(registration)
        return () => { registration.disposed = true }
      },
    },
  }

  assert.doesNotThrow(() => exports.apply(ctx))

  // 样式标签
  assert.equal(document.head.children.length, 1, 'apply 应该往 head 插入一个样式标签')
  const style = document.head.children[0]
  assert.equal(style.tagName, 'STYLE')
  assert.notEqual(style.getAttribute('data-chengmeng-memory'), null, '样式标签必须带 data-chengmeng-memory')
  assert.ok(style.textContent.includes('.cm-mem-dock'), '样式里缺少待确认卡片')
  assert.ok(style.textContent.includes('.cm-mem-settings'), '样式里缺少设置页一节')
  assert.ok(style.textContent.includes('--cm-spring-fade'), '样式里缺少弹簧 token')
  assert.ok(style.textContent.includes('prefers-reduced-motion'), '样式必须尊重减少动态效果')

  // 槽位注册
  assert.equal(registrations.length, 2)
  const dock = registrations.find((registration) => registration.config.name === 'conversation.composer.dock')
  assert.ok(dock, '没有注册 conversation.composer.dock')
  assert.equal(dock.config.id, 'chengmeng-memory-pending')
  assert.equal(dock.config.order, 50)
  assert.equal(typeof dock.Component, 'function')

  const settings = registrations.find((registration) => registration.config.name === 'settings.section')
  assert.ok(settings, '没有注册 settings.section')
  assert.equal(settings.config.id, 'chengmeng-memory')
  assert.equal(settings.config.order, 70)
  assert.equal(typeof settings.config.label, 'function')
  assert.equal(settings.config.label(), '记忆')

  // 卸载：effect 的 disposer 触发后，样式和槽位注册都要撤销
  for (const effect of effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  assert.equal(document.head.children.length, 0, '卸载后样式标签应被移除')
  assert.equal(style.removed, true)
  assert.ok(
    registrations.every((registration) => registration.disposed === true),
    '卸载后槽位注册应被撤销',
  )
})

test('没有 document 的环境里 apply 不抛异常、也不注册任何东西', () => {
  const { entry } = loadBundle({ withDocument: false })
  const exports = entry.factory(() => {
    throw new Error('没有浏览器环境时不应调用 require')
  })
  const ctx = {
    effect() { throw new Error('没有浏览器环境时不应注册样式') },
    slots: {
      inject() { throw new Error('没有浏览器环境时不应注册槽位') },
      register() { throw new Error('没有浏览器环境时不应注册槽位') },
    },
  }
  assert.doesNotThrow(() => exports.apply(ctx))
})

test('槽位服务异常时 apply 静默回退，不把异常抛给 DSH', () => {
  const { entry } = loadBundle()
  const exports = entry.factory(() => fakeReact())
  const ctx = {
    effect() { throw new Error('样式注册失败') },
    slots: {
      inject() { throw new Error('槽位服务不可用') },
      register() { throw new Error('槽位服务不可用') },
    },
  }
  assert.doesNotThrow(() => exports.apply(ctx))
})
