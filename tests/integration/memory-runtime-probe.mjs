// Integration-only bridge: never shipped or installed in the user's profile.
import { tmpdir } from 'node:os'
import { resolve, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'chengmeng-memory-integration-probe'
export const inject = ['agentPresets', 'agents', 'tools', 'sessions', 'sessionQuery', 'webServer', 'connection']
export function apply(ctx) {
  const home = resolve(process.env.DSH_HOME || '.')
  if (dirname(home).toLowerCase() !== resolve(tmpdir()).toLowerCase()
    || !basename(home).startsWith('cm-integration-')) throw new Error('ISOLATED_TEST_HOME_REQUIRED')
  const fixture = ctx.sessions.create('cm-integration-fixture')
  let capabilityAgent, historySession, historySeq
  const samples = {
    normal: '虚构验收：我喜欢午后散步',
    private: '虚构验收：我有医院复诊安排',
    rejected: '虚构验收：我喜欢周末观星',
    job: '虚构验收：周二上午九点参加软件开发岗位面试，需要整理项目经历。',
  }
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/integration-check', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) return send(res, rejection, { error: 'authentication' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    let lease
    try {
      let bytes = 0, body = ''
      for await (const part of req) { bytes += part.length; if (bytes > 2048) return send(res, 413, { error: 'size' }); body += part }
      const input = JSON.parse(body || '{}')
      lease = await ctx.agentPresets.acquireScope('chengmeng')
      const defs = ctx.tools.definitions(lease.key)
      const tool = name => {
        const found = defs.find(item => item.name === name)
        if (!found) throw new Error('MISSING_TOOL:' + name)
        return found
      }
      if(req.url==='/integration-check/history-diagnose'){
        const rows=await ctx.sessionQuery.listSessions(),errors=[]
        for(const row of rows){try{const s=await ctx.sessionQuery.readSurface(row.header.id);if(!s.session.agentPreset)await ctx.sessionQuery.readSession(row.header.id)}catch(e){errors.push({id:row.header.id,error:e.message})}}
        return send(res,200,{count:rows.length,errors,sample:await ctx.sessionQuery.readSurface('cm-history-native')})
      }
      if (req.url === '/integration-check/history-seed') {
        if (!historySession) {
          historySession=ctx.sessions.create('cm-history-native', {meta:{cwd:home,agentPreset:'chengmeng'}})
          for (const content of ['虚构历史：周二准备软件面试。','虚构历史：周五去图书馆借书。','虚构历史：我有医院复诊安排。']) {
            const event=historySession.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:content}]},{surfaceOp:'append'})
            historySeq ??= event.seq
          }
          historySession.append('assistant/message',{turn:0,step:0,message:{id:randomUUID(),role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'虚构助手：建议带上简历。'},{type:'reasoning',text:'fictional_hidden_reasoning'}]},stream:[]},{surfaceOp:'append'})
          const other=ctx.sessions.create('cm-history-other',{meta:{cwd:home,agentPreset:'default'}})
          other.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'不应出现在 Chengmeng 的历史查询中。'}]},{surfaceOp:'append'})
        }
        return send(res,200,{ok:true})
      }
      if (req.url === '/integration-check/history-edit') {
        const event=historySession.append('user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'虚构历史：面试已取消，改为整理书桌。'}]},
          {surfaceOp:{op:'replace',startSeq:historySeq,endSeq:historySeq},sourceEventSeqs:[historySeq]})
        historySeq=event.seq
        return send(res,200,{ok:true})
      }
      if (req.url === '/integration-check/history-recall') {
        return send(res,200,{result:JSON.parse(await tool('recall_history').execute(input.search ? {query:input.search==='edited'?'整理书桌':'软件面试'}:
          {mode:'timeline',period:'today',limit:2,...(input.cursor?{cursor:input.cursor}:{}),include_sensitive:input.includeSensitive===true},{}))})
      }
      if (req.url === '/integration-check/stress') {
        if (![100, 200].includes(input.wave) || !Number.isInteger(input.index) || input.index < 0 || input.index >= input.wave) return send(res, 400, { error: 'fixture_only' })
        const marker = `cmstress${input.wave}x${String(input.index).padStart(3, '0')}`
        const sessionId = `cm-${marker}`
        if (input.op === 'propose') {
          const session = ctx.sessions.get(sessionId) || ctx.sessions.create(sessionId)
          const content = `虚构并发验收 ${marker} 的安排是周五整理书架。`
          session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: content }] }, { surfaceOp: 'append' })
          const result = JSON.parse(await tool('propose_memory').execute({ content, user_quote: content, category: 'goal', stated_by_user: true }, { agent: { session } }))
          return send(res, 200, { ...result, marker, sessionId, content })
        }
        if (input.op === 'recall') {
          const result = await tool('recall_memory').execute({ query: marker, limit: 8 }, {})
          return send(res, 200, { result })
        }
        return send(res, 400, { error: 'fixture_only' })
      }
      if (req.url === '/integration-check/status') {
        capabilityAgent ??= await ctx.agents.create({sessionId:'cm-capability-fixture-'+randomUUID(),meta:{cwd:home,agentPreset:'chengmeng'},setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'chengmeng')}})
        const actualTools=ctx.tools.definitions(capabilityAgent.agent)
        const loader=actualTools.find(t=>t.name==='skill')
        const loaded=[]
        for(const name of ['memory-protocol','daily-life-support','social-reintegration','psychological-support','gender-health-navigation','crisis-referral']) {
          const item=await loader.execute({name},{agent:capabilityAgent.agent});loaded.push({name:item.name,length:item.content.length})
        }
        const skill=loaded.find(s=>s.name==='memory-protocol')
        return send(res, 200, { tools: actualTools.map(item => item.name).sort(), loadedSkills:loaded,
          memorySkillLoaded: skill.name === 'memory-protocol' && skill.length > 500,
          status: JSON.parse(await tool('memory_status').execute({}, {})) })
      }
      if (req.url === '/integration-check/propose') {
        const content = samples[input.case]
        if (!content) return send(res, 400, { error: 'fixture_only' })
        // A standalone synthetic Session, with no Agent loop or model provider.
        fixture.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: content }] }, { surfaceOp: 'append' })
        const result = await tool('propose_memory').execute({ content, user_quote: content,
          category: 'preference', stated_by_user: true }, { agent: { session: fixture } })
        return send(res, 200, { result: JSON.parse(result), sourceSessionId: fixture.id })
      }
      if (req.url === '/integration-check/recall') {
        if (input.mode === 'timeline') {
          const result = await tool('recall_memory').execute({ mode: 'timeline', period: 'today', cursor: input.cursor }, {})
          return send(res, 200, { result })
        }
        const queries = { normal: '午后散步', private: '医院复诊', rejected: '周末观星', job: '之前找工作的准备事项', job_keyword: '软件开发' }
        if (!queries[input.case]) return send(res, 400, { error: 'fixture_only' })
        const result = await tool('recall_memory').execute({ query: queries[input.case], include_sensitive: input.includeSensitive === true }, {})
        return send(res, 200, { result })
      }
      return send(res, 404, { error: 'route' })
    } catch (error) {
      return send(res, 500, { error: String(error?.message || 'TEST_FAILED') })
    } finally { await lease?.[Symbol.asyncDispose]() }
  } }), 'memory integration test probe')
}
