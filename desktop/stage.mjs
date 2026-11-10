import { cp, mkdir, readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { extractFile, getRawHeader, uncacheAll } from '@electron/asar'
import { Pickle } from './node_modules/@electron/asar/lib/pickle.js'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = process.argv[2] || join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
const stage = resolve(process.argv[3] || join(project, '.desktop-build', 'stage'))
const version = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version
await mkdir(stage, { recursive: true })
console.log('Copying the public desktop runtime…')
await cp(vendor, join(stage, 'app'), { recursive: true, filter: source =>
  !/[/\\](?:Uninstall DeepSeek Harness\.exe|app-update\.yml)$/.test(source) })
const modules = []
for (const directory of ['agent-core', 'memory-consent', 'pastel-theme', 'startup-animation', 'support-skills', 'appearance-settings']) {
  const from = join(project, 'plugins', directory), to = join(stage, 'plugins', directory)
  const pkg = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'))
  await mkdir(to, { recursive: true })
  for (const file of ['package.json', ...pkg.files]) {
    await cp(join(from, file), join(to, file), { recursive: true, filter: p => !p.includes('__pycache__') })
  }
  modules.push({ directory, name: pkg.name, version: pkg.version })
}
console.log('Copying the offline CPU model and Python wheels…')
await cp(join(project, '.runtime', 'qwen-embedding', 'model'), join(stage, 'embedding', 'model'), { recursive: true })
await cp(join(project, '.desktop-build', 'wheels-cp312'), join(stage, 'embedding', 'wheels'), { recursive: true })
const requirements = await readFile(join(project, 'desktop', 'requirements-cpu.lock.txt'))
await writeFile(join(stage, 'embedding', 'requirements.lock.txt'), requirements)
await copyFile(join(project, 'desktop', 'prepare.cjs'), join(stage, 'prepare.cjs'))
await copyFile(join(project, 'desktop', 'README.md'), join(stage, 'README.md'))
await copyFile(join(project, 'LICENSE'), join(stage, 'LICENSE'))
await mkdir(join(stage, 'licenses'), { recursive: true })
await copyFile(join(project, 'desktop', 'licenses', 'DeepSeek-MIT.txt'), join(stage, 'licenses', 'DeepSeek-MIT.txt'))
await copyFile(join(project, 'desktop', 'licenses', 'DeepSeek-THIRD-PARTY.txt'), join(stage, 'licenses', 'DeepSeek-THIRD-PARTY.txt'))

// Append replacements to a copy: every immutable dsh offset and unpacked flag
// remains byte-for-byte unchanged. No Electron fuse changes are necessary.
const sourceAsar = join(vendor, 'resources', 'app.asar')
const targetAsar = join(stage, 'app', 'resources', 'app.asar')
const { header, headerSize } = getRawHeader(sourceAsar)
const original = await readFile(sourceAsar)
const data = original.subarray(8 + headerSize)
const pkg = JSON.parse(extractFile(sourceAsar, 'package.json').toString())
if (pkg.version !== '0.2.2-rc.1') throw new Error(`Unverified vendor version: ${pkg.version}`)
pkg.main = 'chengmeng-main.mjs'
pkg.dshDesktopAppId = 'local.chengmeng.desktop'
delete pkg.dshMandatoryUpdatePolicy
const replacements = [
  ['package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n')],
  ['chengmeng-main.mjs', await readFile(join(project, 'desktop', 'chengmeng-main.mjs'))],
]
let offset = data.length
for (const [name, bytes] of replacements) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  header.files[name] = { size: bytes.length, offset: String(offset),
    integrity: { algorithm: 'SHA256', hash: digest, blockSize: 4194304, blocks: [digest] } }
  offset += bytes.length
}
const pickle = Pickle.createEmpty(); pickle.writeString(JSON.stringify(header))
const headerBytes = pickle.toBuffer()
const size = Pickle.createEmpty(); size.writeUInt32(headerBytes.length)
await writeFile(targetAsar, Buffer.concat([size.toBuffer(), headerBytes, data, ...replacements.map(([, bytes]) => bytes)]))
uncacheAll()
if (JSON.parse(extractFile(targetAsar, 'package.json')).main !== pkg.main) throw new Error('ASAR validation failed')
const contentHash = createHash('sha256')
async function hashTree(dir) {
  for (const name of (await readdir(dir)).sort()) {
    const file = join(dir, name)
    if ((await stat(file)).isDirectory()) await hashTree(file)
    else contentHash.update(file.slice(stage.length)).update(await readFile(file))
  }
}
await hashTree(join(stage, 'plugins'))
contentHash.update(await readFile(join(stage, 'prepare.cjs'))).update(replacements[1][1])
await writeFile(join(stage, 'distribution.json'), JSON.stringify({ version, vendorVersion: pkg.version, modules,
  contentId: contentHash.digest('hex'), requirementsSha256: createHash('sha256').update(requirements).digest('hex'),
  model: 'Qwen/Qwen3-Embedding-0.6B', device: 'cpu', python: '3.12.14' }, null, 2) + '\n')
console.log(`Staged Chengmeng ${version}: ${stage}`)
