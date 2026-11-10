import { installToolPolicy } from './src/tool-policy.js'

export const name = 'chengmeng-agent-tool-policy'
export const inject = ['tools']

// Apply to the actual Agent, not the parent preset generation: a parent mask
// would also hide its sibling `skill` tool when inherited by a child Agent.
export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) {
    throw new Error('AGENT_CORE_CONFIG_INVALID')
  }
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => installToolPolicy(agent.ctx, agent), 'chengmeng-agent-core: agent tool policy')
  }), 'chengmeng-agent-core: initialize tool policy')
}
