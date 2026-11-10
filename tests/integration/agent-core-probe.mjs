// Test-only diagnostic plugin. Refuses every home except a task-created temp home.
// Never installed in .dsh-dev or ~/.dsh; no model requests and no real user data.
import { resolve, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { renderPersona } from '../../plugins/agent-core/src/config.js'

export const name = 'chengmeng-agent-core-probe'
export const inject = ['agentPresets', 'systemPrompt', 'tools', 'webServer', 'connection']

export function apply(ctx) {
  const home = resolve(process.env.DSH_HOME || '.')
  if (dirname(home).toLowerCase() !== resolve(tmpdir()).toLowerCase()
    || !basename(home).startsWith('chengmeng-agent-core-')) throw new Error('TEST_HOME_REQUIRED')
  const root = new URL('../../plugins/agent-core/', import.meta.url)
  const config = JSON.parse(readFileSync(new URL('config/agent.json', root), 'utf8'))
  const expected = renderPersona(readFileSync(new URL('persona/persona.md', root), 'utf8'), config)
  const response = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/agent-core-check', handler: async (req, res) => {
    const rejected = ctx.connection.requestRejection(req)
    if (rejected !== undefined) return response(res, rejected, { error: 'authentication' })
    if (req.method !== 'POST' || req.url !== '/agent-core-check/run') return response(res, 405, { error: 'method' })
    let lease
    const releases = []
    try {
      const roster = await ctx.agentPresets.list()
      const selected = roster.find(row => row.id === 'chengmeng')
      if (!selected || selected.broken) throw new Error(selected?.broken || 'PRESET_MISSING')
      lease = await ctx.agentPresets.acquireScope('chengmeng')
      const assembly = await ctx.systemPrompt.assemble({ scope: lease.key })
      const persona = assembly.sections.find(section => section.name === 'deployment:persona-prefix')
      if (persona?.text !== expected) throw new Error('PERSONA_MISMATCH')
      const names = () => ctx.tools.definitions(lease.key).map(tool => tool.name).sort()
      const before = names()
      const dummy = name => ({ name, description: 'Test fixture only; never executes.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: () => [] }, execute: () => 'fixture' })
      for (const name of ['fixture_unsafe_shell', 'memory_status', 'propose_memory', 'recall_memory']) {
        if (ctx.tools.definitions().some(tool => tool.name === name)) continue
        releases.push(ctx.tools.register(dummy(name)))
      }
      const withMemory = names()
      for (const off of releases.splice(0).reverse()) off()
      const after = names()
      const result = {
        preset: selected, defaultPreset: ctx.agentPresets.defaultId,
        personaExactMatch: true, personaCharacters: expected.length,
        personaSha256: createHash('sha256').update(persona.text).digest('hex'),
        otherSectionsPreserved: assembly.sections.length > 1,
        before, withMemory, after,
        unsafeGlobalHidden: !withMemory.includes('fixture_unsafe_shell'),
        memoryToolsVisible: ['memory_status', 'propose_memory', 'recall_memory'].every(n => withMemory.includes(n)),
        nativeSkillVisible: before.includes('skill'),
        restoredAfterRemoval: JSON.stringify(before) === JSON.stringify(after),
      }
      response(res, 200, result)
    } catch (error) {
      // Only this isolated synthetic test route returns diagnostics.
      response(res, 500, { error: String(error?.message || 'PROBE_FAILED') })
    } finally {
      for (const off of releases) off()
      await lease?.[Symbol.asyncDispose]()
    }
  } }), 'agent-core test probe')
}
