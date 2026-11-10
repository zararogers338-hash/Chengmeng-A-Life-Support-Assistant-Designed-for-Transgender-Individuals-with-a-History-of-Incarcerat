export const name = 'chengmeng-agent-core'

// A root anchor is required for DSH's Web manifest to discover the client entry.
// It does not register tools, prompts, routes, services, or model calls.
export function apply(_ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) {
    throw new Error('AGENT_CORE_CONFIG_INVALID')
  }
}
