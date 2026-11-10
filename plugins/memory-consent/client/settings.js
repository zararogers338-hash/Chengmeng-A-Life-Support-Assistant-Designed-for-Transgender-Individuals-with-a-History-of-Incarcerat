/**
 * 设置页的「记忆」一节，挂在官方槽位 settings.section（root 作用域的 list）。
 *
 * 行为（docs/prompts/memory-module.md 第 10 节）：
 * - 总开关默认关；旁边用通俗的话说明数据保存在本机、不会上传；
 * - 普通条目的确认方式（逐条确认 / 自动记住），旁边注明敏感条目始终逐条确认；
 * - 记忆列表：搜索、类别过滤、内容、类别、创建/更新时间、来源、「已由你确认」标记；
 * - 敏感条目的私人原因只在用户主动展开详情时才显示，而且用中性说法；
 * - 逐条修改、删除（二次确认）、导出 Markdown/JSON、删除全部（输入 DELETE）、重建索引；
 * - 打开设置页（组件挂载）时才请求数据，apply 阶段不发任何请求；
 * - 任何请求失败只在区块里显示一行中性提示，不显示堆栈、路径或服务端原文。
 *
 * React 由宿主通过 require('react') 提供，所以只能在组件函数内部取。
 */
import { createMemoryApi, categoryLabel, formatMemoryTime, sensitivityReasonLabels, normalizeMemoryItem, MEMORY_CATEGORIES, downloadMemoryExport } from './api.js'
import { createMemoryErrorBoundary } from './dock.js'

let settingsBoundary = null

function settingsBoundaryFor(React) {
  if (!settingsBoundary) settingsBoundary = createMemoryErrorBoundary(React)
  return settingsBoundary
}

function SettingsSection(props) {
  try {
    const React = require('react')
    const Boundary = settingsBoundaryFor(React)
    return React.createElement(Boundary, null, React.createElement(SettingsSectionBody, props))
  } catch {
    return null
  }
}

function SettingsSectionBody() {
  const React = require('react')

  const apiRef = React.useRef(null)
  if (!apiRef.current) apiRef.current = createMemoryApi()
  const api = apiRef.current

  const [status, setStatus] = React.useState(null)
  const [items, setItems] = React.useState([])
  const [pendingItems, setPendingItems] = React.useState([])
  const [openPendingId, setOpenPendingId] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [historyQuery, setHistoryQuery] = React.useState('')
  const [historyPage, setHistoryPage] = React.useState(null)
  const [category, setCategory] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [reloadKey, setReloadKey] = React.useState(0)
  const [editingId, setEditingId] = React.useState('')
  const [draft, setDraft] = React.useState('')
  const [confirmDeleteId, setConfirmDeleteId] = React.useState('')
  const [deleteWord, setDeleteWord] = React.useState('')
  const aliveRef = React.useRef(true)

  React.useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const reload = React.useCallback(() => { setReloadKey((value) => value + 1) }, [])
  React.useEffect(() => { const timer = setInterval(reload, 5000); return () => clearInterval(timer) }, [reload])

  // The explicit management page can review all sessions, including candidates
  // with unknown origins. Conversation docks show only their own session.
  React.useEffect(() => {
    let live = true
    api.pending().then(payload => {
      if (live) setPendingItems(Array.isArray(payload.items) ? payload.items : [])
    }).catch(() => { if (live) setError('没有加载到待确认内容') })
    return () => { live = false }
  }, [api, reloadKey])

  // 记忆状态：打开设置页时才请求；保存设置后 reloadKey 变化会重新拉一次。
  React.useEffect(() => {
    let live = true
    api.status().then((payload) => {
      if (!live) return
      setStatus({
        enabled: payload.enabled === true,
        normalMode: payload.normalMode === 'auto' ? 'auto' : 'confirm',
        degraded: payload.degraded === true,
        backend: typeof payload.backend === 'string' ? payload.backend : '',
        pendingCount: Number.isFinite(payload.pendingCount) ? payload.pendingCount : 0,
        embedding: payload.embedding || null,
        history: payload.history || null,
      })
    }).catch(() => {
      if (live) setError('没有加载到记忆状态')
    })
    return () => { live = false }
  }, [api, reloadKey])

  // 记忆列表：搜索框防抖 250ms，其余直接请求；组件卸载后丢弃迟到的响应。
  React.useEffect(() => {
    let live = true
    const delay = query.trim() === '' ? 0 : 250
    setLoading(true)
    const timer = setTimeout(() => {
      api.memories({ q: query.trim(), category }).then((payload) => {
        if (!live) return
        const list = Array.isArray(payload.items) ? payload.items.map(normalizeMemoryItem).filter((item) => item.id !== '') : []
        setItems(list)
        setError('')
      }).catch(() => {
        if (live) setError('没有加载到记忆列表')
      }).finally(() => {
        if (live) setLoading(false)
      })
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, query, category, reloadKey])

  /** 统一处理界面动作：失败只显示中性提示，成功给一句中性的结果说明并刷新数据。 */
  const runAction = async (key, task, noticeText) => {
    if (busy) return null
    setBusy(key)
    setError('')
    setNotice('')
    try {
      const result = await task()
      if (aliveRef.current) {
        const text = typeof noticeText === 'function' ? noticeText(result) : noticeText
        if (text) setNotice(text)
        reload()
      }
      return result
    } catch {
      if (aliveRef.current) setError('操作没有完成')
      return null
    } finally {
      if (aliveRef.current) setBusy('')
    }
  }

  const mergeSettings = (settings) => {
    if (!settings) return
    setStatus((prev) => ({
      ...(prev || {}),
      enabled: settings.enabled === true,
      normalMode: settings.normalMode === 'auto' ? 'auto' : 'confirm',
    }))
  }

  const onToggleEnabled = (event) => {
    const next = event.target.checked
    void runAction('enabled', async () => {
      const payload = await api.saveSettings({ enabled: next })
      mergeSettings(payload.settings)
      return payload
    }, '已保存')
  }

  const onNormalMode = (mode) => {
    void runAction('normal-mode', async () => {
      const payload = await api.saveSettings({ normalMode: mode })
      mergeSettings(payload.settings)
      return payload
    }, '已保存')
  }

  const onStartEdit = (item) => {
    setEditingId(item.id)
    setDraft(item.content)
    setConfirmDeleteId('')
    setError('')
    setNotice('')
  }

  const onCancelEdit = () => {
    setEditingId('')
    setDraft('')
  }

  const onSaveEdit = (item) => {
    if (draft.trim() === '') {
      setError('内容不能为空')
      return
    }
    void runAction(`update:${item.id}`, async () => {
      const payload = await api.update(item.id, draft)
      setEditingId('')
      return payload
    }, '已保存')
  }

  const onDelete = (item) => {
    void runAction(`delete:${item.id}`, async () => {
      const payload = await api.remove(item.id)
      setConfirmDeleteId('')
      if (editingId === item.id) setEditingId('')
      return payload
    }, (payload) => payload.warning ? '已删除记忆，索引清理需要重试' : '已删除这一条')
  }

  const onExport = (format) => {
    void runAction(`export:${format}`, () => downloadMemoryExport(format), format === 'json' ? '已开始下载 JSON' : '已开始下载 Markdown')
  }

  const onRebuild = () => {
    void runAction('rebuild', () => api.rebuildIndex(), (payload) => `已重建 ${Number(payload.rebuilt) || 0} 条索引`)
  }

  const onDeleteAll = () => {
    if (deleteWord !== 'DELETE') return
    void runAction('delete-all', async () => {
      const payload = await api.deleteAll()
      setDeleteWord('')
      setConfirmDeleteId('')
      setEditingId('')
      return payload
    }, (payload) => `已删除 ${Number(payload.deleted) || 0} 条`)
  }

  const enabled = status ? status.enabled === true : false
  const normalMode = status ? status.normalMode : 'confirm'
  const degraded = status ? status.degraded === true : false
  const pendingCount = status ? status.pendingCount : 0
  const controlsDisabled = !status || busy !== ''

  const choice = (mode, label) => React.createElement('button', {
    type: 'button',
    className: 'cm-mem-choice',
    'aria-pressed': normalMode === mode ? 'true' : 'false',
    disabled: controlsDisabled,
    onClick: () => onNormalMode(mode),
  }, label)

  const head = React.createElement('div', { className: 'cm-mem-settings-group' },
    React.createElement('h3', { className: 'cm-mem-settings-title' }, '记忆'),
    React.createElement('p', { className: 'cm-mem-settings-hint' }, '记忆文件保存在这台电脑上。检索到的记忆会随对话提供给你选择的模型；使用远程模型时，这些内容会发送给该服务。'),
  )

  const switchRow = React.createElement('div', { className: 'cm-mem-settings-group' },
    React.createElement('label', { className: 'cm-mem-settings-row' },
      React.createElement('input', {
        type: 'checkbox',
        className: 'cm-mem-check',
        checked: enabled,
        disabled: controlsDisabled,
        onChange: onToggleEnabled,
      }),
      React.createElement('span', { className: 'cm-mem-settings-title' }, '长期记忆'),
    ),
    React.createElement('p', { className: 'cm-mem-settings-hint' }, '默认开启自动保存，无需逐条确认。关闭后保留已有整理记忆，停止新增和检索。'),
  )

  const normalModeGroup = React.createElement('div', { className: 'cm-mem-settings-group' },
    React.createElement('p', { className: 'cm-mem-settings-title' }, '整理记忆的保存方式'),
    React.createElement('div', { className: 'cm-mem-settings-row' },
      choice('auto', '全自动保存'),
      choice('confirm', '手动确认（可选）'),
    ),
    React.createElement('p', { className: 'cm-mem-settings-hint' }, '不使用敏感词分类和检索过滤；自动保存会保留来源，也会明确标为自动记录。'),
  )

  const degradedNote = degraded
    ? React.createElement('p', { className: 'cm-mem-settings-hint' }, '语义检索后端不可用，已改用关键词检索。')
    : null

  const listHead = React.createElement('div', { className: 'cm-mem-settings-row' },
    React.createElement('p', { className: 'cm-mem-settings-title' }, '已保存的整理记忆'),
    React.createElement('span', { className: 'cm-mem-settings-hint' }, `共 ${items.length} 条`),
    pendingCount > 0
      ? React.createElement('span', { className: 'cm-mem-settings-hint' }, `另有 ${pendingCount} 条待确认，会出现在输入框下方。`)
      : null,
  )

  const toolbar = React.createElement('div', { className: 'cm-mem-toolbar' },
    React.createElement('input', {
      type: 'search',
      className: 'cm-mem-input cm-mem-search',
      value: query,
      placeholder: '搜索记忆',
      'aria-label': '搜索记忆',
      onChange: (event) => setQuery(event.target.value),
    }),
    React.createElement('select', {
      className: 'cm-mem-select',
      value: category,
      'aria-label': '按类别过滤',
      onChange: (event) => setCategory(event.target.value),
    }, [
      React.createElement('option', { key: 'all', value: '' }, '全部类别'),
      ...MEMORY_CATEGORIES.map((entry) => React.createElement('option', { key: entry.id, value: entry.id }, entry.label)),
    ]),
  )

  const rows = items.map((item) => {
    const editing = editingId === item.id
    const confirming = confirmDeleteId === item.id
    const created = formatMemoryTime(item.createdAt)
    const updated = formatMemoryTime(item.updatedAt)

    const meta = [
      React.createElement('span', { key: 'category', className: 'cm-mem-tag' }, categoryLabel(item.category)),
    ]
    if (created) meta.push(React.createElement('span', { key: 'created' }, `记于 ${created}`))
    if (updated && updated !== created) meta.push(React.createElement('span', { key: 'updated' }, `改于 ${updated}`))
    if (item.source) {
      meta.push(React.createElement('span', {
        key: 'source',
        className: 'cm-mem-source',
        title: item.source,
      }, `来源 ${item.source}`))
    }
    if (item.confirmedByUser) meta.push(React.createElement('span', { key: 'confirmed', className: 'cm-mem-tag cm-mem-tag-ok' }, '已由你确认'))
    if (item.savedAutomatically) meta.push(React.createElement('span', { key: 'automatic', className: 'cm-mem-tag cm-mem-tag-ok' }, '自动保存'))
    if (item.editedByUser) meta.push(React.createElement('span', { key: 'edited', className: 'cm-mem-tag' }, '你改过文字'))

    const children = [
      React.createElement('p', { key: 'text', className: 'cm-mem-mem-text' }, item.content),
      React.createElement('div', { key: 'meta', className: 'cm-mem-row-meta' }, meta),
    ]


    if (editing) {
      children.push(React.createElement('div', { key: 'edit', style: { marginTop: '8px' } },
        React.createElement('textarea', {
          className: 'cm-mem-input cm-mem-textarea',
          value: draft,
          rows: 3,
          'aria-label': '修改这条记忆',
          spellCheck: false,
          onChange: (event) => setDraft(event.target.value),
        }),
        React.createElement('div', { className: 'cm-mem-row-actions' },
          React.createElement('button', {
            type: 'button',
            className: 'cm-mem-btn cm-mem-btn-sm cm-mem-btn-primary',
            disabled: busy !== '',
            onClick: () => onSaveEdit(item),
          }, '保存'),
          React.createElement('button', {
            type: 'button',
            className: 'cm-mem-btn cm-mem-btn-sm cm-mem-btn-quiet',
            disabled: busy !== '',
            onClick: onCancelEdit,
          }, '取消'),
        ),
      ))
    } else if (confirming) {
      children.push(React.createElement('div', { key: 'confirm', className: 'cm-mem-row-actions' },
        React.createElement('span', { className: 'cm-mem-settings-hint' }, '删除后无法恢复。'),
        React.createElement('button', {
          type: 'button',
          className: 'cm-mem-btn cm-mem-btn-sm cm-mem-btn-danger',
          disabled: busy !== '',
          onClick: () => onDelete(item),
        }, '确认删除'),
        React.createElement('button', {
          type: 'button',
          className: 'cm-mem-btn cm-mem-btn-sm cm-mem-btn-quiet',
          disabled: busy !== '',
          onClick: () => setConfirmDeleteId(''),
        }, '取消'),
      ))
    } else {
      children.push(React.createElement('div', { key: 'actions', className: 'cm-mem-row-actions' },
        React.createElement('button', {
          type: 'button',
          className: 'cm-mem-btn cm-mem-btn-sm',
          disabled: busy !== '',
          onClick: () => onStartEdit(item),
        }, '修改'),
        React.createElement('button', {
          type: 'button',
          className: 'cm-mem-btn cm-mem-btn-sm cm-mem-btn-danger',
          disabled: busy !== '',
          onClick: () => { setConfirmDeleteId(item.id); setEditingId('') },
        }, '删除'),
      ))
    }

    return React.createElement('li', { key: item.id, className: 'cm-mem-row' }, children)
  })

  const listSection = React.createElement('div', { className: 'cm-mem-settings-group' },
    listHead,
    toolbar,
    error ? React.createElement('p', { className: 'cm-mem-error', role: 'status' }, error) : null,
    notice ? React.createElement('p', { className: 'cm-mem-notice', role: 'status' }, notice) : null,
    rows.length > 0
      ? React.createElement('ul', { className: 'cm-mem-list' }, rows)
      : React.createElement('p', { className: 'cm-mem-empty' }, loading
        ? '正在读取记忆'
        : (query.trim() !== '' || category !== '' ? '没有找到匹配的记忆' : '还没有记忆')),
  )

  const footer = React.createElement('div', { className: 'cm-mem-settings-footer' },
    React.createElement('button', {
      type: 'button',
      className: 'cm-mem-btn cm-mem-btn-sm',
      disabled: busy !== '',
      onClick: () => onExport('md'),
    }, '导出 Markdown'),
    React.createElement('button', {
      type: 'button',
      className: 'cm-mem-btn cm-mem-btn-sm',
      disabled: busy !== '',
      onClick: () => onExport('json'),
    }, '导出 JSON'),
    React.createElement('button', {
      type: 'button',
      className: 'cm-mem-btn cm-mem-btn-sm',
      disabled: busy !== '',
      onClick: onRebuild,
    }, '重建索引'),
  )

  const danger = React.createElement('div', { className: 'cm-mem-danger' },
    React.createElement('p', { className: 'cm-mem-settings-title' }, '删除全部整理记忆'),
    React.createElement('p', { className: 'cm-mem-settings-hint' }, '移除整理记忆、候选和对应索引；原生聊天、聊天档案、上传附件和旧备份不在这项操作范围内。'),
    React.createElement('div', { className: 'cm-mem-settings-row' },
      React.createElement('input', {
        type: 'text',
        className: 'cm-mem-input',
        value: deleteWord,
        placeholder: '输入 DELETE 确认',
        'aria-label': '输入 DELETE 确认删除全部记忆',
        autoComplete: 'off',
        onChange: (event) => setDeleteWord(event.target.value),
      }),
      React.createElement('button', {
        type: 'button',
        className: 'cm-mem-btn cm-mem-btn-sm cm-mem-btn-danger',
        disabled: busy !== '' || deleteWord !== 'DELETE',
        onClick: onDeleteAll,
      }, '删除全部'),
    ),
  )

  const children = [head, switchRow, normalModeGroup]
  if (status?.history) {
    children.push(React.createElement('div', { className: 'cm-mem-settings-group' },
      React.createElement('label', { className: 'cm-mem-settings-row' },
        React.createElement('input', { type: 'checkbox', checked: status.history.enabled === true,
          disabled: busy !== '' || !status.history.available, 'aria-label': '自动记住全部聊天',
          onChange: event => { const enabled = event.target.checked; void runAction('history', () => api.historySettings(enabled), '已保存历史检索偏好') } }),
        React.createElement('span', { className: 'cm-mem-settings-title' }, '自动记住全部聊天')),
      React.createElement('p', { className: 'cm-mem-settings-hint' }, '自动保存本实例 Chengmeng 的用户消息、助手回复和已读取资料，不需要手动确认。检索覆盖全部已存时间范围，引用保留角色和来源。'),
      React.createElement('p', { className: 'cm-mem-settings-hint' }, `已保存 ${Number(status.history.messages) || 0} 条消息，来自 ${Number(status.history.sessions) || 0} 个会话。${status.history.indexing ? 'CPU 正在更新语义索引，关键词查询可立即使用。' : '聊天更新后会自动同步。'}`),
      React.createElement('div', { className: 'cm-mem-toolbar' },
        React.createElement('input', { className: 'cm-mem-input cm-mem-search', type: 'search', value: historyQuery,
          placeholder: '搜索聊天记忆，例如书名、章节、安排', 'aria-label': '搜索聊天记忆',
          onChange: event => { setHistoryQuery(event.target.value); setHistoryPage(null) } }),
        React.createElement('button', { className: 'cm-mem-btn', type: 'button', disabled: busy !== '' || !status.history.enabled,
          onClick: () => { void runAction('history-search', async () => { const page = await api.historySearch(historyQuery.trim() ? {query:historyQuery.trim(),limit:8} : {mode:'timeline',limit:8}); setHistoryPage(page); return page }, '') } }, '查找聊天记忆')),
      historyPage ? React.createElement('div', null,
        React.createElement('p', { role: 'status', className: 'cm-mem-settings-hint' }, historyPage.message || (historyPage.results?.length ? `本页 ${historyPage.results.length} 条${historyPage.partial ? '，有会话暂时未读到' : ''}` : '这次查询没有找到匹配内容')),
        React.createElement('ul', { className: 'cm-mem-list' }, ...(historyPage.results || []).map(item => React.createElement('li', { key:item.id, className:'cm-mem-row' },
          React.createElement('p', {className:'cm-mem-mem-text'}, item.content),
          React.createElement('span', {className:'cm-mem-settings-hint',title:item.source}, formatMemoryTime(item.source_time))))),
        historyPage.has_more ? React.createElement('button', {type:'button',className:'cm-mem-btn',disabled:busy!=='',onClick:()=>{void runAction('history-next',async()=>{const page=await api.historySearch({mode:'timeline',limit:8,cursor:historyPage.next_cursor});setHistoryPage(page);return page},'')}},'下一页') : null,
      ) : null,
    ))
  }
  if (status?.embedding) {
    const embedding = status.embedding
    const message = embedding.reason === 'model_or_runtime_missing'
      ? '这台电脑未安装向量模型或运行环境，继续使用关键词检索。'
      : embedding.reason === 'insufficient_memory'
        ? '可用内存不足，继续使用关键词检索。'
        : degraded ? '向量模型暂时不可用，继续使用关键词检索。'
          : embedding.running ? 'CPU 模型已加载，正在使用语义与关键词混合检索。'
            : 'CPU 模型按需加载，空闲两分钟后释放内存；时间回顾不依赖模型。'
    children.push(React.createElement('div', { className: 'cm-mem-settings-group' },
      React.createElement('h3', { className: 'cm-mem-settings-title' }, '本地语义检索'),
      React.createElement('p', { className: 'cm-mem-settings-hint' }, `${embedding.model} · CPU · ${embedding.dimensions} 维`),
      React.createElement('p', { className: 'cm-mem-settings-hint', role: 'status' }, message),
    ))
  }
  if (pendingItems.length) {
    children.push(React.createElement('div', { className: 'cm-mem-settings-group' },
      React.createElement('h3', { className: 'cm-mem-settings-title' }, '待确认内容'),
      React.createElement('ul', { className: 'cm-mem-list' }, pendingItems.map(item => {
        const open = openPendingId === item.id
        return React.createElement('li', { key: item.id, className: 'cm-mem-row' },
          React.createElement('button', { type: 'button', className: 'cm-mem-btn',
            'aria-expanded': open, onClick: () => setOpenPendingId(open ? '' : item.id) },
          open ? '收起候选内容' : '查看候选内容'),
          open ? React.createElement('div', null,
            React.createElement('p', { className: 'cm-mem-mem-text' }, item.content),
            React.createElement('div', { className: 'cm-mem-row-actions' },
              React.createElement('button', { type: 'button', className: 'cm-mem-btn cm-mem-btn-primary',
                disabled: !enabled || busy !== '',
                onClick: () => { void runAction(`confirm:${item.id}`, () => api.confirm(item.id), '已记住这一条') } }, '记住这条候选'),
              React.createElement('button', { type: 'button', className: 'cm-mem-btn', disabled: busy !== '',
                onClick: () => { void runAction(`reject:${item.id}`, () => api.reject(item.id), '已拒绝这一条') } }, '不用这条候选'),
            ),
          ) : null,
        )
      })),
    ))
  }
  if (degraded) children.push(degradedNote)
  children.push(listSection, footer, danger)

  return React.createElement('section', {
    className: 'cm-mem-settings',
    'aria-label': '记忆',
  }, ...children)
}
