/**
 * DSH 客户端入口。构建时会被拼接在 springs/api/styles/dock/settings 之后，
 * 包进 window.__ModuleLoader__.load 的 factory 里，所以可以直接使用它们的顶层符号。
 * `require` 由模块加载器传入，只用来在组件函数内部取宿主自带的 react（不在顶层 require）。
 *
 * apply 只做注册：一个样式标签 + 两个官方槽位，全部放进 ctx.effect，卸载时撤销。
 * 任何一步失败都静默跳过（这个功能不显示），绝不能让 DSH 界面白屏。
 */

const name = '@chengmeng/dsh-memory-consent'
const inject = ['slots']

const MEMORY_STYLE_ATTRIBUTE = 'data-chengmeng-memory'

/** 注册一个槽位：槽位不存在、宿主版本不同或注册失败时，这个功能只是不显示。 */
function registerMemorySlot(ctx, slotName, config, Component, label) {
  try {
    ctx.effect(() => {
      let active = true
      let dispose = null
      const release = () => {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            // 已经撤销
          }
        }
        dispose = null
      }
      try {
        ctx.slots.inject(slotName, () => {
          try {
            const registered = ctx.slots.register({ ...config, name: slotName }, Component)
            if (!active) {
              // 槽位在插件已经卸载之后才可用：立刻撤销这次迟到的注册。
              if (typeof registered === 'function') {
                try {
                  registered()
                } catch {
                  // 宿主自己已经处理
                }
              }
              return undefined
            }
            dispose = registered
            return registered
          } catch {
            dispose = null
            return undefined
          }
        })
      } catch {
        // 槽位服务不可用：什么都不注册
      }
      return () => {
        active = false
        release()
      }
    }, label)
  } catch {
    // ctx.effect 本身失败也不影响 DSH 界面
  }
}

function apply(ctx) {
  if (!ctx || typeof ctx !== 'object') return
  // 没有浏览器环境（SSR、冒烟测试）时什么都不做：apply 不允许抛异常。
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  // 1) 样式：一个 <style data-chengmeng-memory> 标签，卸载时移除。
  try {
    ctx.effect(() => {
      const style = document.createElement('style')
      style.setAttribute(MEMORY_STYLE_ATTRIBUTE, '')
      // 弹簧 CSS 变量只挂在本模块自己的根节点上（见 memoryCSS 的第一条规则）。
      style.textContent = memoryCSS(springCSSVariables())
      document.head.appendChild(style)
      return () => {
        try {
          style.remove()
        } catch {
          // 已经被移除
        }
      }
    }, 'chengmeng memory: styles')
  } catch {
    // 样式失败只是不好看，不阻断功能
  }

  // 2) 待确认条：输入框下方（conversation.composer.dock，session 作用域的 list）。
  registerMemorySlot(ctx, 'conversation.composer.dock', {
    id: 'chengmeng-memory-pending',
    order: 50,
  }, ComposerDock, 'chengmeng memory: composer dock')

  // 3) 设置页「记忆」一节（settings.section，root 作用域的 list）。
  registerMemorySlot(ctx, 'settings.section', {
    id: 'chengmeng-memory',
    order: 70,
    label: () => '记忆',
  }, SettingsSection, 'chengmeng memory: settings section')
}
