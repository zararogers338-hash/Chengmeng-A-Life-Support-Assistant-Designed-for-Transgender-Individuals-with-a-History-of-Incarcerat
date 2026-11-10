import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises'
import {join,dirname,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {createHistoryService,expandConversationSurface} from '../../plugins/memory-consent/src/history.js'
import {createStore} from '../../plugins/memory-consent/src/store.js'
import {createConsentService} from '../../plugins/memory-consent/src/consent.js'
import {createKeywordBackend} from '../../plugins/memory-consent/src/backends/keyword.js'
import {createSearchService} from '../../plugins/memory-consent/src/search.js'
import {buildRecord} from '../../plugins/memory-consent/src/model.js'
import {createQwenBackend} from '../../plugins/memory-consent/src/backends/qwen.js'
import {validateConfig} from '../../plugins/memory-consent/src/config.js'

const time=Date.parse('2025-01-03T01:00:00Z')
const user=(seq,text)=>({type:'user/message',seq,time,data:{source:{kind:'user'},content:[{type:'text',text}]}})
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'cm-auto-memory-'));t.after(async()=>{assert.equal(dirname(dir),tmpdir());assert(basename(dir).startsWith('cm-auto-memory-'));await rm(dir,{recursive:true,force:true})});return dir}

test('自动历史：无需 propose 或手工确认，完整保存长消息，覆盖90天以前与第2000片段之后',async t=>{
  const dir=await fixture(t),events=Array.from({length:2002},(_,i)=>user(i,`虚构旧聊天事项${i}`))
  events.push(user(2002,'长消息开始'+ '🙂'.repeat(2400)+'最后独有的紫色灯塔'))
  const provider={listSessions:async()=>[{header:{id:'a',agentPreset:'chengmeng'}}],readSurface:async()=>({session:{agentPreset:'chengmeng'},events})}
  const history=createHistoryService({dataDir:dir,getSessionQuery:()=>provider,timeZone:'Asia/Shanghai'})
  await history.refresh()
  const state=await history.status();assert.equal(state.enabled,true);assert.equal(state.messages,2003);assert(state.chunks>2003)
  const page=await history.recall({mode:'timeline',limit:8});assert.equal(page.total,state.chunks);assert.equal(page.partial,false)
  const found=await history.recall({query:'紫色灯塔',include_sensitive:false});assert.equal(found.status,'ok')
  assert(found.results.some(r=>r.content.includes('最后独有的紫色灯塔')))
  const archives=await readdir(join(dir,'history-archive'));assert.equal(archives.length,1)
  const raw=await readFile(join(dir,'history-archive',archives[0]),'utf8');assert(raw.includes('最后独有的紫色灯塔'))
  assert(!raw.includes('confirmed_by_user'))
  history.dispose()
})

test('历史压缩：展开仍有效的检查点，编辑替换的旧消息不恢复',()=>{
  const original=user(0,'旧句'),edited={...user(1,'改过的句子'),sourceEventSeqs:[0],surfaceOp:{op:'replace',startSeq:0,endSeq:0}}
  const answer={type:'assistant/message',seq:2,time,data:{message:{content:[{type:'text',text:'助手回答'}]}}}
  const compact={type:'user/message',seq:3,time,data:{source:{kind:'compact-checkpoint'},content:[{type:'text',text:'压缩摘要'}]},sourceEventSeqs:[1,2]}
  const expanded=expandConversationSurface([compact],[original,edited,answer,compact])
  assert.deepEqual(expanded.map(e=>e.seq),[1,2]);assert(!JSON.stringify(expanded).includes('旧句'))
  const originalTool={type:'tool/result',seq:4,time,data:{message:{content:[{type:'text',text:'完整文档中段'}]}}}
  const prune={type:'compaction/prune',seq:5,time,data:{}}
  const shortened={type:'tool/result',seq:6,time,data:{message:{content:[{type:'text',text:'头尾'}]}},sourceEventSeqs:[4]}
  assert.deepEqual(expandConversationSurface([shortened],[originalTool,prune,shortened]),[originalTool])
})

test('自动整理与旧敏感记录：Markdown往返、关键词、向量和时间线全部可查询',async t=>{
  const dir=await fixture(t),store=createStore({dataDir:dir});await store.writeSettings({enabled:true,normalMode:'auto'})
  const keyword=createKeywordBackend({dataDir:dir}),search=createSearchService({backend:keyword,getRecord:id=>store.getMemory(id)})
  const consent=createConsentService({store,backend:keyword,search,verifyQuote:async()=>true})
  const result=await consent.propose({content:'虚构书籍的民主定义：和平更换执政者。',user_quote:'民主可以和平换人',category:'episode',stated_by_user:true,sensitivity_hint:'sensitive'},{sessionId:'fictional'})
  assert.equal(result.status,'saved');assert.equal((await store.listPending()).length,0)
  const automatic=await store.getMemory(result.id);assert.equal(automatic.confirmed_by_user,false);assert.equal(automatic.saved_automatically,true);assert.equal(automatic.sensitivity,'normal')
  const legacy=buildRecord({content:'旧版敏感标记：民主、被抓、社会与政治章节',category:'episode',sensitivity:'sensitive',reasons:['incarceration'],source:'session:legacy#turn:1',confirmed_by_user:true,quote_verified:true})
  await store.addMemory(legacy);await keyword.add(legacy)
  const response=await consent.recall({query:'民主',include_sensitive:false,limit:8});assert.equal(response.results.length,2)
  const timeline=await consent.recall({mode:'timeline',include_sensitive:false,limit:8});assert.equal(timeline.total,2)
  const qwen=createQwenBackend({dataDir:dir,config:{...validateConfig({}).qwen,dimensions:32},getRecords:async()=>(await store.listMemories()).records,
    encoder:{health:async()=>({configured:true,ok:true}),encode:async texts=>texts.map(()=>Array(32).fill(1)),dispose(){}}})
  const vectorHits=await qwen.search('民主',{includeSensitive:false,limit:8});assert.equal(vectorHits.length,2)
  qwen.dispose()
})

test('切换全自动：已有待确认候选自动迁移，标明自动保存',async t=>{
  const dir=await fixture(t),store=createStore({dataDir:dir});await store.writeSettings({enabled:true,normalMode:'confirm'})
  const keyword=createKeywordBackend({dataDir:dir}),search=createSearchService({backend:keyword,getRecord:id=>store.getMemory(id)})
  const consent=createConsentService({store,backend:keyword,search,verifyQuote:async()=>true})
  const p=await consent.propose({content:'虚构迁移事项',category:'explicit',user_quote:'虚构迁移事项',stated_by_user:true},{sessionId:'fixture'})
  assert.equal(p.status,'pending')
  const changed=await consent.updateSettings({normalMode:'auto'});assert.equal(changed.migrated,1)
  assert.equal((await store.listPending()).length,0);assert.equal((await store.getMemory(p.id)).saved_automatically,true)
})

test('后台自动归档：消息完成后调度，无需先搜索才产生文件',async t=>{
  const dir=await fixture(t),provider={listSessions:async()=>[{header:{id:'auto',agentPreset:'chengmeng'}}],readSurface:async()=>({session:{agentPreset:'chengmeng'},events:[user(0,'自动归档验收') ]})}
  const history=createHistoryService({dataDir:dir,getSessionQuery:()=>provider,timeZone:'Asia/Shanghai'})
  history.schedule()
  const deadline=Date.now()+3000
  while(!(await history.status()).messages&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal((await history.status()).messages,1);assert.equal((await readdir(join(dir,'history-archive'))).length,1)
  history.dispose()
})

test('旧会话模式切换：创建时standard、后来选择Chengmeng，仍补读完整聊天',async t=>{
  const dir=await fixture(t),events=[user(0,'虚构旧书全文：民主的两条最低线'),{type:'agent-preset/selected',seq:1,time,data:{agentPreset:'chengmeng'}}]
  const provider={listSessions:async()=>[{header:{id:'switched',agentPreset:'standard'}}],
    readSurface:async()=>({session:{agentPreset:'standard'},events:[events[0]]}),readSession:async()=>({session:{agentPreset:'standard'},events})}
  const history=createHistoryService({dataDir:dir,getSessionQuery:()=>provider,timeZone:'Asia/Shanghai'})
  await history.refresh();const page=await history.recall({query:'民主'})
  assert.equal(page.status,'ok');assert.equal(page.results.length,1);assert(page.results[0].content.includes('旧书全文'))
  history.dispose()
})

test('可选工作区范围：相同预设的其他工作区不进入验收历史',async t=>{
  const dir=await fixture(t),workspace=join(dir,'our-workspace')
  const provider={listSessions:async()=>[{header:{id:'ours',agentPreset:'chengmeng',cwd:workspace}},{header:{id:'foreign',agentPreset:'chengmeng',cwd:join(dir,'other-workspace')}}],
    readSurface:async id=>{assert.equal(id,'ours');return{session:{agentPreset:'chengmeng'},events:[user(0,'本次独立验收资料')]}}}
  const history=createHistoryService({dataDir:dir,getSessionQuery:()=>provider,timeZone:'Asia/Shanghai',workspace})
  const page=await history.recall({mode:'timeline'});assert.equal(page.total,1);assert.equal(page.partial,false)
  assert.equal((await history.status()).sessions,1);history.dispose()
})
