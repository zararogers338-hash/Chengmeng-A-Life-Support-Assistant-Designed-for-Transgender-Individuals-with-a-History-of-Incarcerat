import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { createHistoryService } from '../../plugins/memory-consent/src/history.js'
import { apply as supportApply, lookupReferences, CATALOG } from '../../plugins/support-skills/index.js'

test('专业资料：五个独立 Skill 可加载，引用 ID 均存在且有地区与核验日期', async () => {
  const skills = [], tools = [], disposers = []
  supportApply({ skills: { register: s => {skills.push(s);return()=>skills.splice(skills.indexOf(s),1)} },
    tools: {register:t=>{tools.push(t);return()=>tools.splice(tools.indexOf(t),1)}}, effect: fn=>disposers.push(fn()) })
  assert.equal(skills.length,5);assert.equal(tools.length,1)
  for(const skill of skills){assert(skill.content.length>500 && skill.content.length<=8192);assert(skill.whenToUse)}
  const ids=['who-stress','who-pfa','unodc-reintegration','who-gender','ftc-budget','who-crisis']
  const result=JSON.parse(await tools[0].execute({ids},{}))
  assert.equal(result.references.length,6)
  for(const source of result.references){assert(source.url.startsWith('https://'));assert(source.region);assert(source.verified);assert(source.evidence)}
  assert.equal(lookupReferences(['unknown']).ok,false)
  assert.equal(lookupReferences(['who-stress'],new Date('2027-06-01')).references[0].needs_recheck,true)
  disposers.reverse().forEach(fn=>fn());assert.equal(skills.length,0);assert.equal(tools.length,0)
})

test('外观设置客户端使用宿主模块格式，无网络和任意代码执行', async () => {
  const source=await readFile(new URL('../../plugins/appearance-settings/client.js',import.meta.url),'utf8')
  let module
  runInNewContext(source,{window:{__ModuleLoader__:{load:m=>module=m}}})
  const exports=module.factory(()=>{throw new Error('top level require')})
  assert.equal(exports.name,'@chengmeng/dsh-appearance-settings')
  assert.equal(typeof exports.apply,'function')
  assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|innerHTML|eval\(/)
  const theme=await readFile(new URL('../../plugins/pastel-theme/src/client-entry.js',import.meta.url),'utf8')
  assert.match(theme,/chengmeng-appearance-change/)
})

async function historyFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'cm-history-unit-'))
  t.after(async()=>{assert.equal(dirname(dir),tmpdir());assert(basename(dir).startsWith('cm-history-unit-'));await rm(dir,{recursive:true,force:true})})
  let reads=0
  const time=Date.parse('2026-11-03T01:00:00Z')
  let events=[{type:'user/message',seq:1,time,data:{source:{kind:'user'},content:[{type:'text',text:'周二准备软件面试，整理项目经历。'}]}},
    {type:'assistant/message',seq:2,time:time+1,data:{message:{content:[{type:'text',text:'可以先准备项目清单。'},{type:'reasoning',text:'hidden reasoning must not be indexed'}]}}}]
  const provider={listSessions:async()=>[{header:{id:'allowed',agentPreset:'chengmeng'}},{header:{id:'other',agentPreset:'standard'}}],
    readSession:async()=>{throw new Error('known header should use current surface')},
    readSurface:async id=>{reads++;assert.equal(id,'allowed');return{session:{id,agentPreset:'chengmeng'},events}}}
  const history=createHistoryService({dataDir:dir,getSessionQuery:()=>provider,timeZone:'Asia/Shanghai',clock:()=>new Date('2026-11-10T01:00:00Z'),defaultEnabled:false})
  t.after(()=>history.dispose())
  return {history,dir,reads:()=>reads,setEvents:value=>{events=value}}
}

test('历史：关闭时不读聊天；开启后按时间列举用户/助手消息，排除其他模式和推理块',async t=>{
  const f=await historyFixture(t)
  assert.equal((await f.history.recall({mode:'timeline',period:'last_week'})).status,'disabled');assert.equal(f.reads(),0)
  await f.history.setEnabled(true)
  const page=await f.history.recall({mode:'timeline',period:'last_week'})
  assert.equal(page.total,2);assert.equal(page.scope,'chengmeng_history_excerpt')
  assert.deepEqual(new Set(page.results.map(x=>x.author_role)),new Set(['user','assistant']))
  assert(!JSON.stringify(page).includes('hidden reasoning'))
  assert(!JSON.stringify(page).includes('confirmed_by_user'))
})

test('历史：当前消息被编辑/删除后不返回旧文本，关闭清理派生索引',async t=>{
  const f=await historyFixture(t);await f.history.setEnabled(true)
  assert.equal((await f.history.recall({query:'软件面试'})).status,'ok')
  f.setEvents([])
  assert.equal((await f.history.recall({query:'软件面试'})).results.length,0)
  await f.history.setEnabled(false)
  assert.equal((await f.history.recall({query:'软件面试'})).status,'disabled')
  assert(!(await readdir(f.dir)).includes('history-index'))
})

test('历史：一条会话不可读时返回其余资料，并明确标记覆盖不全',async t=>{
  const f=await historyFixture(t)
  const provider={listSessions:async()=>[{header:{id:'bad',agentPreset:'chengmeng'}},{header:{id:'good',agentPreset:'chengmeng'}}],readSession:async()=>{},
    readSurface:async id=>{if(id==='bad')throw new Error('fixture unreadable');return{session:{id,agentPreset:'chengmeng'},events:[{type:'user/message',seq:0,time:Date.parse('2026-11-03T01:00:00Z'),data:{source:{kind:'user'},content:[{type:'text',text:'虚构可读资料'}]}}]}}}
  const history=createHistoryService({dataDir:f.dir,getSessionQuery:()=>provider,timeZone:'Asia/Shanghai',clock:()=>new Date('2026-11-10T01:00:00Z')})
  await history.setEnabled(true)
  const result=await history.recall({mode:'timeline',period:'last_week'})
  assert.equal(result.status,'ok');assert.equal(result.total,1);assert.equal(result.partial,true);assert.equal(result.unreadableSessions,1)
})
