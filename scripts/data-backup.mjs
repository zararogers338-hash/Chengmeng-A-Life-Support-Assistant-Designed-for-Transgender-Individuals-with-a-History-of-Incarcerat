import { mkdir, readdir, lstat, readFile, writeFile, rename, rmdir, access } from 'node:fs/promises'
import { resolve, join, relative, dirname, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const exists=path=>access(path).then(()=>true,()=>false)
function child(root,path){const target=resolve(root,path),rel=relative(resolve(root),target);if(!rel||rel==='..'||rel.startsWith('..'+sep)||resolve(rel)===rel)throw Error('PATH_OUTSIDE_BACKUP');return target}
async function files(root){
  const rows=[]
  async function walk(dir,prefix=''){
    let entries
    try{entries=await readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return;throw e}
    for(const entry of entries){const path=join(dir,entry.name),name=prefix+entry.name;if(entry.isSymbolicLink())throw Error('SYMLINK_NOT_SUPPORTED');if(entry.isDirectory())await walk(path,name+'/');else if(entry.isFile())rows.push(name)}
  }
  await walk(root);return rows.sort()
}
function allowed(path){
  if(typeof path!=='string'||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))return false
  return /^memory-data\/(settings\.json|history-settings\.json|history-state\.json|history-archive\/[0-9a-f]{64}\.json|memory\/[^/]+\.md|pending\/[^/]+\.json)$/.test(path)||/^(sessions|attachments)\/.+/.test(path)
}
export async function backupData({home,destination,memoryDir=join(home,'chengmeng','memory')}){
  home=resolve(home);destination=resolve(destination);memoryDir=resolve(memoryDir)
  if(destination===home||destination.startsWith(home+sep)||destination===memoryDir||destination.startsWith(memoryDir+sep))throw Error('BACKUP_MUST_BE_OUTSIDE_SOURCE')
  if(await exists(destination))throw Error('BACKUP_DESTINATION_EXISTS')
  const mappings=[]
  async function inventory(){
    return [...(await files(memoryDir)).filter(p=>allowed('memory-data/'+p)).map(p=>({path:'memory-data/'+p,source:child(memoryDir,p)})),
      ...(await files(join(home,'sessions'))).map(p=>({path:'sessions/'+p,source:child(join(home,'sessions'),p)})),
      ...(await files(join(home,'attachments'))).map(p=>({path:'attachments/'+p,source:child(join(home,'attachments'),p)}))]
  }
  mappings.push(...await inventory())
  const stage=destination+'.partial-'+randomUUID();await mkdir(stage,{recursive:true})
  const manifest={format:'chengmeng-plaintext-backup',version:1,created:new Date().toISOString(),
    includes:['saved Markdown','automatic history archives','pending candidates','memory switches','native DSH sessions','uploaded attachments'],
    excludes:['account credentials','profile settings','derived indexes','browser appearance preferences'],files:[]}
  for(const row of mappings){const bytes=await readFile(row.source),target=child(stage,row.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);manifest.files.push({path:row.path,bytes:bytes.length,sha256:digest(bytes)})}
  // Detect concurrent edits; an interrupted snapshot remains explicitly .partial.
  if(JSON.stringify((await inventory()).map(r=>r.path))!==JSON.stringify(mappings.map(r=>r.path)))throw Error('DATA_CHANGED_DURING_BACKUP_STOP_HOST_AND_RETRY')
  for(let i=0;i<mappings.length;i++)if(digest(await readFile(mappings[i].source))!==manifest.files[i].sha256)throw Error('DATA_CHANGED_DURING_BACKUP_STOP_HOST_AND_RETRY')
  await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
  await rename(stage,destination)
  return {ok:true,destination,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)}
}
export async function restoreData({backup,home}){
  backup=resolve(backup);home=resolve(home)
  if(await exists(home)){if((await readdir(home)).length)throw Error('RESTORE_REQUIRES_EMPTY_HOME')}
  if(home===backup||home.startsWith(backup+sep)||backup.startsWith(home+sep))throw Error('RESTORE_MUST_BE_SEPARATE')
  const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'))
  if(manifest.format!=='chengmeng-plaintext-backup'||manifest.version!==1||!Array.isArray(manifest.files))throw Error('BACKUP_FORMAT_INVALID')
  const seen=new Set(),verified=[]
  for(const item of manifest.files){
    if(!allowed(item.path)||seen.has(item.path))throw Error('BACKUP_PATH_INVALID');seen.add(item.path)
    const source=child(backup,item.path),parts=item.path.split('/');let ancestor=backup
    for(const part of parts){ancestor=child(ancestor,part);if((await lstat(ancestor)).isSymbolicLink())throw Error('SYMLINK_NOT_SUPPORTED')}
    const bytes=await readFile(source);if(bytes.length!==item.bytes||digest(bytes)!==item.sha256)throw Error('BACKUP_CHECKSUM_MISMATCH')
    verified.push({path:item.path,bytes})
  }
  const stage=home+'.restore-'+randomUUID();await mkdir(stage,{recursive:true})
  for(const item of verified){const path=item.path.startsWith('memory-data/')?'chengmeng/memory/'+item.path.slice(12):item.path;const target=child(stage,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,item.bytes)}
  if(await exists(home))await rmdir(home) // only the previously verified empty target; never recursive
  await rename(stage,home)
  return {ok:true,home,files:verified.length,indexes:'rebuild on next retrieval',account:'sign in separately'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [action,...args]=process.argv.slice(2),options={}
  for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('USAGE: backup --home PATH --destination PATH [--memory-dir PATH] | restore --backup PATH --home EMPTY_PATH');options[args[i].slice(2)]=args[i+1]}
  try{
    let result
    if(action==='backup'&&options.home&&options.destination)result=await backupData({home:options.home,destination:options.destination,...options['memory-dir']?{memoryDir:options['memory-dir']}:{}})
    else if(action==='restore'&&options.backup&&options.home)result=await restoreData({backup:options.backup,home:options.home})
    else throw Error('INVALID_BACKUP_ARGUMENTS')
    console.log(JSON.stringify(result,null,2))
  }catch(e){console.error(e.message);process.exitCode=1}
}
