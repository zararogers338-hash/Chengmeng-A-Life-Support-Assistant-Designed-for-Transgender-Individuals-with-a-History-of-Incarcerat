/** Public product configuration only: no credentials, model IDs, or user facts. */
export function validateAgentConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'AGENT_DISPLAY_NAME')) {
    throw new Error('AGENT_CONFIG_INVALID')
  }
  const name = value.AGENT_DISPLAY_NAME
  // Same UTF-16 limit as the existing startup animation. Restrict the grammar
  // so a display name can never introduce a prompt variable or a YAML directive.
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 24
      || !/^[\p{L}\p{M}\p{N} ·_-]+$/u.test(name)) {
    throw new Error('AGENT_DISPLAY_NAME_INVALID')
  }
  return Object.freeze({ AGENT_DISPLAY_NAME: name.trim() })
}

export function renderPersona(template, config) {
  const { AGENT_DISPLAY_NAME } = validateAgentConfig(config)
  if (typeof template !== 'string' || !template.includes('[[AGENT_DISPLAY_NAME]]')) {
    throw new Error('PERSONA_TEMPLATE_INVALID')
  }
  const text = template.replaceAll('[[AGENT_DISPLAY_NAME]]', AGENT_DISPLAY_NAME).trim()
  // Persona is a system-prompt section, not an 8192-character Skill result.
  // 65536 is our build sanity limit, not a claimed DSH Persona limit.
  if (/\[\[|\]\]|\{\{|\}\}/.test(text) || !text || text.length > 65536) {
    throw new Error('PERSONA_TEMPLATE_INVALID')
  }
  return text
}
