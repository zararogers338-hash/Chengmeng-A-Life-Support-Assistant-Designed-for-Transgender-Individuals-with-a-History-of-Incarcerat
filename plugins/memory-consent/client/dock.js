/**
 * 输入框下方的「待确认」玻璃卡片，挂在官方槽位 conversation.composer.dock（session 作用域的 list）。
 *
 * 行为（docs/prompts/memory-module.md 第 10 节）：
 * - 记忆开启、有候选时才渲染；关闭时返回 null，不占高度；
 * - 显示候选文字、「来自你刚才说的」/「来源未能核对」和 记住 / 修改 / 不用 三个按钮；
 * - 卡片上绝不出现类别名或任何能看出身份的字眼，敏感条目只用中性措辞；
 * - 轮询、in-flight 保护、页面隐藏时暂停，都在 api.js 的 createMemoryStore 里；
 * - 组件卸载时停止轮询；渲染期任何异常都被错误边界拦下，回退为「这个功能不显示」。
 *
 * React 由宿主通过 require('react') 提供，所以只能在组件函数内部取。
 */
import { createMemoryStore } from './api.js'

let dockBoundary = null

/** 错误边界：任何渲染期异常都回退为 null，绝不让 DSH 界面白屏。 */
export function createMemoryErrorBoundary(React) {
  class MemoryErrorBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { failed: false }
    }

    static getDerivedStateFromError() {
      return { failed: true }
    }

    componentDidCatch() {
      // 静默处理：不打印任何用户内容，也不把错误抛给 DSH。
    }

    render() {
      return this.state.failed ? null : this.props.children
    }
  }
  return MemoryErrorBoundary
}

function dockBoundaryFor(React) {
  if (!dockBoundary) dockBoundary = createMemoryErrorBoundary(React)
  return dockBoundary
}

/** 标题：普通条目直接问；敏感条目用中性说法，不解释敏感在哪里。 */
function dockTitleFor(item) {
  return item.sensitivity === 'sensitive' ? '这一条比较私人，要记住吗' : '要记住这一条吗'
}

/** 来源小字：只有明确核对过才说「来自你刚才说的」，其余统一中性地说明来源未能核对。 */
function dockSourceNoteFor(item) {
  return item.quoteVerified === true ? '来源已在本段对话中核对' : '来源未能核对'
}

function ComposerDock(props) {
  try {
    const React = require('react')
    const Boundary = dockBoundaryFor(React)
    return React.createElement(Boundary, null, React.createElement(ComposerDockBody, props))
  } catch {
    return null
  }
}

function ComposerDockBody(props) {
  const React = require('react')
  // 标准 props 里带 sessionId；拒绝接口用它把"已拒绝"的记录限制在本次会话内。
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''

  const store = React.useMemo(() => createMemoryStore({ sessionId }), [sessionId])
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot)

  React.useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])

  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [revealed, setRevealed] = React.useState(false)
  const inputRef = React.useRef(null)

  const item = snapshot.pending.length > 0 ? snapshot.pending[0] : null
  const itemId = item ? item.id : ''

  React.useEffect(() => {
    setEditing(false)
    setDraft(item ? item.content : '')
    setFailed(false)
    setRevealed(false)
  }, [itemId])

  React.useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  if (!snapshot.ready || !snapshot.enabled || !item || snapshot.dismissed) return null

  const run = async (task) => {
    if (submitting) return false
    setSubmitting(true)
    setFailed(false)
    try {
      await task(item)
      store.forget(item.id)
      store.refreshPending()
      return true
    } catch {
      // 中性提示一句，不显示服务端原始错误。
      setFailed(true)
      return false
    } finally {
      setSubmitting(false)
    }
  }

  const privateHidden = item.sensitivity === 'sensitive' && !revealed
  const onRemember = () => { if (!privateHidden) void run((current) => store.api.confirm(current.id)) }
  const onReject = () => { void run((current) => store.api.reject(current.id, sessionId)) }
  const onEdit = () => {
    setRevealed(true)
    setDraft(item.content)
    setFailed(false)
    setEditing(true)
  }
  const onCancelEdit = () => {
    setEditing(false)
    setDraft(item.content)
    setFailed(false)
  }
  const onSave = async () => {
    if (draft.trim() === '') {
      setFailed(true)
      return
    }
    const saved = await run((current) => store.api.confirm(current.id, draft))
    if (saved) setEditing(false)
  }
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (editing) onCancelEdit()
    else store.dismiss()
  }

  const head = React.createElement('div', { className: 'cm-mem-dock-head' },
    React.createElement('p', { className: 'cm-mem-dock-title' }, dockTitleFor(item)),
  )

  const meta = [
    React.createElement('span', { key: 'source', className: 'cm-mem-dock-note' }, dockSourceNoteFor(item)),
  ]
  if (snapshot.pending.length > 1) {
    meta.push(React.createElement('span', { key: 'more', className: 'cm-mem-dock-note' }, `还有 ${snapshot.pending.length - 1} 条待确认`))
  }

  const children = [head]
  if (privateHidden) {
    children.push(React.createElement('button', { type: 'button', className: 'cm-mem-btn',
      onClick: () => setRevealed(true), 'aria-label': '查看这条私人候选' }, '查看内容'))
  } else {
    children.push(React.createElement('p', { className: 'cm-mem-dock-text' }, item.content))
  }
  children.push(React.createElement('div', { className: 'cm-mem-dock-meta' }, meta))

  if (editing) {
    children.push(React.createElement('textarea', {
      key: 'input',
      ref: inputRef,
      className: 'cm-mem-dock-input cm-mem-textarea',
      value: draft,
      rows: 3,
      'aria-label': '修改要记住的内容',
      spellCheck: false,
      onChange: (event) => setDraft(event.target.value),
      onKeyDown: (event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        event.preventDefault()
        onCancelEdit()
      },
    }))
    children.push(React.createElement('div', { key: 'actions', className: 'cm-mem-dock-actions' },
      React.createElement('button', {
        type: 'button',
        className: 'cm-mem-btn cm-mem-btn-primary',
        disabled: submitting,
        onClick: () => { void onSave() },
      }, '保存'),
      React.createElement('button', {
        type: 'button',
        className: 'cm-mem-btn cm-mem-btn-quiet',
        disabled: submitting,
        onClick: onCancelEdit,
      }, '取消'),
    ))
  } else {
    children.push(React.createElement('div', { key: 'actions', className: 'cm-mem-dock-actions' },
      React.createElement('button', {
        type: 'button',
        className: 'cm-mem-btn cm-mem-btn-primary',
        disabled: submitting || privateHidden,
        onClick: onRemember,
      }, '记住'),
      React.createElement('button', {
        type: 'button',
        className: 'cm-mem-btn',
        disabled: submitting,
        onClick: onEdit,
      }, '修改'),
      React.createElement('button', {
        type: 'button',
        className: 'cm-mem-btn cm-mem-btn-quiet',
        disabled: submitting,
        onClick: onReject,
      }, '不用'),
    ))
  }

  if (failed) {
    children.push(React.createElement('p', { key: 'error', className: 'cm-mem-dock-error', role: 'status' }, '没有提交成功'))
  }

  return React.createElement('section', {
    className: 'cm-mem-dock',
    'aria-label': '待确认的记忆',
    'aria-busy': submitting ? 'true' : undefined,
    onKeyDown,
  }, children)
}
