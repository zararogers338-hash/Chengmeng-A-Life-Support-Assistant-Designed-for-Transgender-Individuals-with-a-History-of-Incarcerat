window.__ModuleLoader__.load({ id: '@chengmeng/dsh-appearance-settings', factory: (require) => {
  const keys = { pastel: 'chengmeng.appearance.pastel', glass: 'chengmeng.appearance.glass', startup: 'chengmeng.appearance.startup' }
  function read() {
    try { return { pastel: localStorage.getItem(keys.pastel) !== 'off', startup: localStorage.getItem(keys.startup) !== 'off',
      glass: ['off','standard','rich'].includes(localStorage.getItem(keys.glass)) ? localStorage.getItem(keys.glass) : 'auto' } }
    catch { return { pastel: true, startup: true, glass: 'auto' } }
  }
  function Settings() {
    const React = require('react')
    const [value, setValue] = React.useState(read)
    const [notice, setNotice] = React.useState('')
    React.useEffect(() => {
      const update = () => setValue(read())
      window.addEventListener('storage', update)
      window.addEventListener('chengmeng-appearance-change', update)
      return () => { window.removeEventListener('storage', update); window.removeEventListener('chengmeng-appearance-change', update) }
    }, [])
    function save(field, next) {
      try {
        if (next === 'auto' || next === true) localStorage.removeItem(keys[field])
        else localStorage.setItem(keys[field], next === false ? 'off' : next)
        window.dispatchEvent(new Event('chengmeng-appearance-change'))
        setValue(read()); setNotice(field === 'startup' ? '下次打开页面时生效' : '已应用')
      } catch { setNotice('当前浏览器无法保存偏好') }
    }
    const checkbox = (field, label) => React.createElement('label', { className: 'cm-appearance-row' },
      React.createElement('input', { type: 'checkbox', checked: value[field], 'aria-label': label,
        onChange: event => save(field, event.target.checked) }), label)
    return React.createElement('section', { className: 'cm-appearance', 'aria-label': '外观与启动' },
      React.createElement('h3', null, '外观与启动'),
      React.createElement('p', null, '这些偏好只影响当前浏览器的界面，不改变对话、模型或记忆。'),
      checkbox('pastel', '粉白蓝 Pastel 外观'),
      React.createElement('p', null, 'Pastel 保持浅色；关闭后恢复原有主题。窄屏使用纯色背景。'),
      React.createElement('label', { className: 'cm-appearance-row' }, '玻璃效果',
        React.createElement('select', { value: value.glass, 'aria-label': '玻璃效果', onChange: event => save('glass', event.target.value) },
          ...[['auto','自动'],['off','不透明'],['standard','标准磨砂'],['rich','折射玻璃']].map(([id,label]) => React.createElement('option', { key: id, value: id }, label)))),
      React.createElement('p', null, '系统的高对比度、减少透明度等偏好优先于此选择。'),
      checkbox('startup', '播放启动动画'),
      React.createElement('p', null, '系统开启减少动态效果时不播放；变化在下次打开页面时生效。'),
      React.createElement('button', { type: 'button', onClick: () => {
        try { Object.values(keys).forEach(key => localStorage.removeItem(key)); window.dispatchEvent(new Event('chengmeng-appearance-change')); setValue(read()); setNotice('已恢复默认外观') }
        catch { setNotice('当前浏览器无法保存偏好') }
      } }, '恢复默认外观'),
      React.createElement('p', { role: 'status' }, notice))
  }
  function apply(ctx) {
    if (typeof document === 'undefined') return
    ctx.effect(() => {
      const style = document.createElement('style')
      style.setAttribute('data-chengmeng-appearance-settings', '')
      style.textContent = '.cm-appearance{max-width:720px;color:var(--dsw-alias-text-primary,#20242d)}.cm-appearance p{line-height:1.7;font-size:13px;opacity:.8}.cm-appearance-row{display:flex;align-items:center;gap:12px;margin:22px 0 8px;flex-wrap:wrap}.cm-appearance select,.cm-appearance button{font:inherit;padding:8px 12px;border:1px solid var(--dsw-alias-border-main,#d8dbe2);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit}.cm-appearance :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4176e6);outline-offset:3px}'
      document.head.appendChild(style)
      return () => style.remove()
    }, 'appearance settings style')
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'chengmeng-appearance-settings',
      order: 65, label: () => '外观与启动' }, Settings))
  }
  return { name: '@chengmeng/dsh-appearance-settings', inject: ['slots'], apply }
} })
