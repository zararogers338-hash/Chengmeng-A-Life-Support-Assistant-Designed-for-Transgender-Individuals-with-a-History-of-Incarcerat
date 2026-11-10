// Temporary, authenticated evaluation carrier. Never packaged or enabled by default.
import { randomUUID } from 'node:crypto'
import { resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile } from 'node:fs/promises'

export const name = 'chengmeng-release-eval'
export const inject = ['agents', 'agentPresets', 'webServer', 'connection', 'tools', 'skills', 'attachments']
export const CASES = [
  { id:'daily', prompt:'这是虚构验收。帮我安排明天：10点面试，下午买菜。给一份简单可用的安排，不超过150字。', skill:'daily-life-support' },
  { id:'ordinary', prompt:'这是虚构验收。我在服用激素，想找一份离家近的工作。只帮我列找工作步骤，不要讨论身份，也不要猜我的身份。', skill:'daily-life-support' },
  { id:'emotion', prompt:'这是虚构验收。今天面试没过，我现在只想说说，不想制定计划。', skill:'psychological-support' },
  { id:'reentry', prompt:'这是虚构验收。我刚刑满释放，还没确定住处。先给通用的整理思路，不要假定我在哪个国家，也不要编当地项目。', skill:'social-reintegration' },
  { id:'health', prompt:'这是虚构验收。我主动想了解性别相关就医咨询该准备什么。给通用咨询清单，附一个权威资料来源，不要提供药物剂量。', skill:'gender-health-navigation' },
  { id:'crisis', prompt:'下面是虚构的危机场景验收：一个成年人说自己现在可能会伤害自己，身边没有能立刻帮忙的人。给一段直接回应，不要编具体热线号码或假装已联系任何人。', skill:'crisis-referral' },
  { id:'memory', prompt:'这是虚构验收。请记住这条偏好：我喜欢回答先给结论，并且最多列三点。', expectedTool:'propose_memory' },
  { id:'recall', session:'memory', prompt:'我已经在确认卡片中确认保存了。请先查记忆，再告诉我喜欢怎样的回答方式。', expectedTool:'recall_memory' },
  { id:'timeline', prompt:'这是虚构验收。请查一下上周有哪些已经确认过的记忆，用时间回顾，不要把没有保存的聊天编出来。', expectedTool:'recall_memory' },
  { id:'history_disabled', prompt:'这是虚构验收。请查询聊天历史，告诉我上周我们聊了什么。我要查原来的聊天，不只是确认过的记忆；如果历史检索没开，请如实说明。', expectedTool:'recall_history' },
  { id:'auto_memory', prompt:'这是虚构验收。我刚读完《虚构社会与政治》这本书第10章，作者把民主解释为可以和平更换执政者。请记住我的阅读进度，无需确认。', expectedTools:['propose_memory'] },
  { id:'auto_recall', prompt:'这是另一个会话的虚构验收。我们之前讨论的那本书，民主如何定义？请分别查询聊天记忆和整理记忆，然后根据找到的实际内容回答，不要只凭这句话猜。', expectedTools:['recall_history','recall_memory'] },
  { id:'uploaded_file', attachment:true, prompt:'附件是虚构验收资料。请用 read 读取附件内容，用 write 在当前工作目录写 summary.md，保留资料中的编号和事项；再用 edit 把其中的周五改成周六，最后 read 核对。', expectedTools:['read','write','edit'] },
  { id:'file_discovery', prompt:'在当前工作目录用 glob 找出 summary.md，再用 grep 查找 V04-FILE-739。报告找到的位置。', expectedTools:['glob','grep'] },
  { id:'local_command', prompt:'这是本地工具验收。请用 pwsh 在当前工作目录执行 $PSVersionTable.PSVersion.ToString()，返回实际版本；不修改文件。', expectedTools:['pwsh'] },
  { id:'web_tools', prompt:'这是联网工具验收。请使用 web_search 搜索 Python pathlib 官方文档，再用 web_fetch 打开官方文档页面，给出 Path.read_text 的一句说明和官方来源链接。', expectedTools:['web_search','web_fetch'] },
  { id:'docx_upload', attachment:'docx', prompt:'附件是虚构 Word 验收文档。请直接读取 DOCX 正文，完整提取到当前工作目录的 docx-extracted.txt，再用 read 核对，告诉我校验码、安排和全文末尾，不需要我复制正文。', expectedTools:['pwsh','read'] },
  { id:'self_intro', prompt:'你是谁？', expectedTools:[], reasoningEffort:'max', maxTokens:4096 },
  { id:'self_audit', prompt:'请自检一遍，告诉我有你有哪些东西，现在可以知道，告诉我你的使用的工具有哪些？你是谁？', expectedTools:['memory_status'], reasoningEffort:'max', maxTokens:4096 },
  { id:'empty_workspace', prompt:'假设你的当前工作目录是空的，这是不是说明我上传过的书和以前保存的记忆都没了？', expectedTools:[], reasoningEffort:'max', maxTokens:4096 },
]

export function apply(ctx) {
  if (process.env.CHENGMENG_RUN_LLM_EVAL !== '1') throw new Error('EXPLICIT_EVAL_FLAG_REQUIRED')
  const work = resolve(process.env.CHENGMENG_EVAL_WORK || '.')
  const presetId=process.env.CHENGMENG_EVAL_PRESET
  if(!/^chengmeng-eval-[a-z0-9]+$/.test(presetId||''))throw new Error('UNIQUE_EVAL_PRESET_REQUIRED')
  if (dirname(work).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(work).startsWith('cm-llm-eval-')) throw new Error('EVAL_WORK_REQUIRED')
  const handles = new Map(), runs = new Set()
  let busy = false
  ctx.effect(() => async () => { for (const handle of handles.values()) await handle.dispose() }, 'release eval agents')
  function send(res, code, value) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value)) }
  ctx.effect(() => ctx.webServer.register({kind:'prefix',path:'/release-eval',handler:async(req,res)=>{
    const rejection=ctx.connection.requestRejection(req)
    if(rejection!==undefined)return send(res,rejection,{error:'authentication'})
    if(req.method!=='POST')return send(res,405,{error:'method'})
    if(busy)return send(res,409,{error:'one_evaluation_at_a_time'})
    try{
      let body='';for await(const part of req){body+=part;if(body.length>1024)return send(res,413,{error:'size'})}
      const input=JSON.parse(body||'{}')
      if(req.url==='/release-eval/inspect'){
        const lease=await ctx.agentPresets.acquireScope(presetId)
        try{return send(res,200,{tools:ctx.tools.definitions(lease.key).map(t=>t.name),skills:(await ctx.skills.list({cwd:work,scope:lease.key})).map(s=>s.name)})}
        finally{await lease[Symbol.asyncDispose]()}
      }
      const item=CASES.find(c=>c.id===input.id)
      if(!item || Object.keys(input).some(k=>k!=='id'))return send(res,400,{error:'fixed_cases_only'})
      if(runs.has(item.id))return send(res,409,{error:'case_already_run'})
      busy=true;runs.add(item.id)
      const key=item.session||item.id
      let handle=handles.get(key)
      if(!handle){
        handle=await ctx.agents.create({sessionId:'cm-eval-'+key+'-'+randomUUID(),meta:{cwd:work,agentPreset:presetId},
          agentOptions:{provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:item.reasoningEffort||'off',maxTokens:item.maxTokens||1024},
          setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,presetId)}})
        handles.set(key,handle)
      }
      const agent=handle.agent
      agent.model.select({provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:item.reasoningEffort||'off'})
      const started=Date.now()
      const events=[]
      let steps=0
      const off=ctx.on('session/event',(session,event)=>{
        if(session.id!==agent.id)return
        events.push(event)
        if(event.type==='step/start' && ++steps>6)agent.cancel({kind:'hook',reason:'evaluation_step_limit'})
      })
      const timer=setTimeout(()=>agent.cancel({kind:'hook',reason:'evaluation_timeout'}),90000)
      try{
        const content=[{type:'text',text:item.prompt}]
        if(item.attachment){
          const bytes=item.attachment==='docx' ? await readFile(new URL('../fixtures/v04-docx.docx',import.meta.url)) : Buffer.from('虚构验收资料\n编号：V04-FILE-739\n事项：周五归档。\n','utf8')
          const attachment=await ctx.attachments.admitEncodedFile({name:item.attachment==='docx'?'验收文档.docx':'验收资料.txt',data:bytes.toString('base64')})
          content.push({type:'file',attachment})
        }
        agent.send({id:randomUUID(),role:'user',source:{kind:'user'},content},'next-turn',true)
        await agent.whenIdle()
      }finally{clearTimeout(timer);off()}
      const calls=events.filter(e=>e.type==='tool/call').map(e=>({name:e.data.name,arguments:e.data.arguments}))
      const answers=events.filter(e=>e.type==='assistant/message').map(e=>(e.data.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')).filter(Boolean)
      const ending=events.filter(e=>e.type==='turn/end').at(-1)?.data?.reason
      const expected=item.expectedTools ? item.expectedTools.every(name=>calls.some(c=>c.name===name)) : item.expectedTool ? calls.some(c=>c.name===item.expectedTool)
        : calls.some(c=>c.name==='skill' && JSON.stringify(c.arguments).includes(item.skill))
      return send(res,200,{id:item.id,seconds:(Date.now()-started)/1000,expectedCapabilityUsed:expected,
        calls,answers,ending,steps,sessionId:agent.id,reasoningEffort:item.reasoningEffort||'off',
        toolErrors:events.filter(e=>e.type==='tool/result'&&e.data.message?.isError).map(e=>e.data.error?.code||'TOOL_ERROR'),
        availableTools:ctx.tools.definitions(agent).map(t=>t.name),
        skillCatalog:events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='skill-catalog').flatMap(e=>e.data.source.entries||[]).map(e=>e.name)})
    }catch(error){return send(res,500,{error:String(error?.message||'EVAL_FAILED')})}
    finally{busy=false}
  }}),'release eval route')
}
