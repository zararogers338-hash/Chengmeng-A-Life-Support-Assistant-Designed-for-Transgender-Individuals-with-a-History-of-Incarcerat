import { renderPersona, validateAgentConfig } from './config.js'

export const PRESET_ID = 'chengmeng'
export const PACKAGE_NAME = '@chengmeng/dsh-agent-core'

/** Native scoped Persona; the host's default preset and old sessions are untouched. */
export function createPatch(config, personaTemplate, replyStyleTemplate = '') {
  const { AGENT_DISPLAY_NAME } = validateAgentConfig(config)
  return [{ insert: [
    { id: 'chengmeng-agent-core', name: PACKAGE_NAME, config: {} },
    {
    id: 'preset-chengmeng',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: PRESET_ID,
      name: AGENT_DISPLAY_NAME,
      description: '聊聊近况，梳理日常事务与下一步。',
      order: 0,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
          prefix: renderPersona(personaTemplate, config),
          suffix: replyStyleTemplate ? renderPersona(replyStyleTemplate, config) : '', complete: false, includeRuntimeContext: true,
        } },
        { id: 'chengmeng-agent-tool-policy', name: `${PACKAGE_NAME}/policy`, config: {} },
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: true, readLimit: 400, readMaxBytes: 24000 } },
        { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
        { id: 'tool-shell', name: process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash',
          config: { enableRunInBackground: false, promoteOnTimeout: false } },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { search: true, fetch: true,
          searchMaxQueries: 2, searchMaxResults: 5, searchSummaryMaxChars: 600, fetchMaxOutputChars: 200000, searchTimeoutMs: 60000 } },
        { id: 'compaction', name: 'cordis:group', group: true,
          isolate: { compaction: true, toolResultPruner: true }, config: [
            { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
            { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
            { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
              config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
          ],
        },
      ],
    },
  }] }]
}

// This small emitter only accepts JSON-shaped values produced above. Strings are
// JSON-quoted YAML scalars; multiline Persona text uses a literal block.
export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const scalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v)
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`
    return value.map(item => scalar(item)
      ? `${pad}- ${JSON.stringify(item)}`
      : `${pad}-\n${toYaml(item, indent + 2)}`).join('\n')
  }
  if (!value || typeof value !== 'object') throw new Error('YAML_VALUE_INVALID')
  if (!Object.keys(value).length) return `${pad}{}`
  return Object.entries(value).map(([key, item]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) throw new Error('YAML_KEY_INVALID')
    if (typeof item === 'string' && item.includes('\n')) {
      return `${pad}${key}: |-\n${item.split('\n').map(line => `${pad}  ${line}`).join('\n')}`
    }
    return scalar(item)
      ? `${pad}${key}: ${JSON.stringify(item)}`
      : `${pad}${key}:\n${toYaml(item, indent + 2)}`
  }).join('\n')
}
