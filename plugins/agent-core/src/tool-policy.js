// Public capabilities inherited by the actual Agent from global/preset scopes.
export const MEMORY_TOOLS = Object.freeze(['memory_status', 'propose_memory', 'recall_memory', 'recall_history', 'support_reference', 'skill',
  'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'pwsh', 'bash', 'web_search', 'web_fetch'])

export function installToolPolicy(ctx, agent) {
  let release = null
  let appliedKey = null
  let updating = false
  let disposed = false
  function refresh() {
    if (updating || disposed) return
    updating = true
    try {
      const registered = new Set([...ctx.tools.definitions(), ...ctx.tools.definitions(agent)].map(tool => tool.name))
      const allowed = MEMORY_TOOLS.filter(name => registered.has(name))
      const key = allowed.join(',')
      if (key === appliedKey) return
      // Install the replacement before releasing the old mask: a reload must
      // never briefly expose unrelated host tools during replacement.
      const nextRelease = ctx.tools.restrict({ allow: new Set(allowed) })
      const previous = release
      release = nextRelease
      appliedKey = key
      previous?.()
    } finally {
      updating = false
    }
  }
  refresh()
  const off = ctx.on('tools/change', refresh)
  return () => {
    disposed = true
    off()
    release?.()
    release = null
  }
}
