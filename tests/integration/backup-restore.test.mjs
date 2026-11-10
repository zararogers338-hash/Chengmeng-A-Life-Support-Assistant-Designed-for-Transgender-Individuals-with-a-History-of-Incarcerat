import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import {join,dirname,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {backupData,restoreData} from '../../scripts/data-backup.mjs'
import {createStore} from '../../plugins/memory-consent/src/store.js'
import {buildRecord} from '../../plugins/memory-consent/src/model.js'
import {createKeywordBackend} from '../../plugins/memory-consent/src/backends/keyword.js'

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'cm-backup-test-'));t.after(async()=>{assert.equal(dirname(root),tmpdir());assert(basename(root).startsWith('cm-backup-test-'));await rm(root,{recursive:true,force:true})});return root}
test('明文备份恢复：确认记忆可重建查询，保留原生日志，排除账号与派生索引',async t=>{
  const root=await fixture(t),home=join(root,'source'),dataDir=join(home,'chengmeng/memory'),backup=join(root,'backup'),restored=join(root,'restored')
  const store=createStore({dataDir});await store.writeSettings({enabled:true,normalMode:'confirm'})
  const record=buildRecord({content:'虚构备份测试：每周五整理书架',category:'preference',sensitivity:'normal',reasons:[],source:'session:fixture#turn:1',confirmed_by_user:true,quote_verified:true})
  await store.addMemory(record)
  await mkdir(join(home,'sessions','fictional'),{recursive:true});await writeFile(join(home,'sessions/fictional/log.jsonl'),'fictional native session bytes\n')
  await mkdir(join(home,'attachments','v1'),{recursive:true});await writeFile(join(home,'attachments/v1/fixture.txt'),'fictional uploaded attachment')
  await writeFile(join(home,'.credentials.yaml'),'fictional credential must not enter snapshot')
  await writeFile(join(dataDir,'index','keyword.json'),'fictional stale index')
  const result=await backupData({home,destination:backup});assert(result.ok)
  const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));assert(!JSON.stringify(manifest).includes('.credentials'))
  assert(!manifest.files.some(f=>f.path.includes('/index/')))
  assert(manifest.files.some(f=>f.path.endsWith('.md')))
  await restoreData({backup,home:restored})
  const newStore=createStore({dataDir:join(restored,'chengmeng/memory')});const records=(await newStore.listMemories()).records
  assert.equal(records.length,1);assert.equal(records[0].content,record.content)
  const keyword=createKeywordBackend({dataDir:join(restored,'chengmeng/memory')});await keyword.rebuild(records)
  const hits=await keyword.search('周五整理书架',{limit:5});assert(hits.some(h=>h.id===record.id))
  assert.equal(await readFile(join(restored,'sessions/fictional/log.jsonl'),'utf8'),'fictional native session bytes\n')
  assert.equal(await readFile(join(restored,'attachments/v1/fixture.txt'),'utf8'),'fictional uploaded attachment')
  assert.equal((await newStore.readSettings()).enabled,true)
  await assert.rejects(restoreData({backup,home:restored}),/EMPTY_HOME/)
})
test('恢复前完整校验：篡改、路径越界与非空目录均不覆盖任何数据',async t=>{
  const root=await fixture(t),home=join(root,'source'),backup=join(root,'backup'),target=join(root,'restore')
  await mkdir(join(home,'chengmeng/memory'),{recursive:true});await writeFile(join(home,'chengmeng/memory/settings.json'),'{}')
  await backupData({home,destination:backup})
  await writeFile(join(backup,'memory-data/settings.json'),'corrupted')
  await assert.rejects(restoreData({backup,home:target}),/CHECKSUM/)
  assert(!(await readdir(root)).includes('restore'))
  const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));manifest.files[0].path='../escape';await writeFile(join(backup,'manifest.json'),JSON.stringify(manifest))
  await assert.rejects(restoreData({backup,home:target}),/PATH_INVALID/)
})
