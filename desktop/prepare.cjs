// Executed with the bundled Electron's Node mode. Never reads account secrets.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const root = path.resolve(__dirname)
const home = path.resolve(process.argv[2] || '')
if (!process.argv[2] || home === root) throw new Error('A separate data home is required.')
const runtimeModules = path.join(root, 'app', 'resources', 'app.asar', 'dsh', 'node_modules')
const info = JSON.parse(fs.readFileSync(path.join(root, 'distribution.json'), 'utf8'))
const status = message => console.log(message)
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const run = (exe, args) => {
  const env = { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PIP_NO_INDEX: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH
  const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Runtime setup failed: ${result.error?.message || result.stderr || result.stdout}`)
}
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(path.join(home, 'run'), { recursive: true })
const basePython = path.join(root, 'app', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe')
const venv = path.join(root, 'embedding', 'venv')
const python = path.join(venv, 'Scripts', 'python.exe')
const readyFile = path.join(root, 'embedding', 'ready.json')
let ready
try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')) } catch {}
if (ready?.requirementsSha256 !== info.requirementsSha256 || !fs.existsSync(python)) {
  status('正在准备本地 CPU 记忆模型（无需下载）…')
  run(basePython, ['-I', '-m', 'venv', venv])
  run(python, ['-I', '-m', 'pip', 'install', '--no-index', '--no-cache-dir', '--disable-pip-version-check',
    '--find-links', path.join(root, 'embedding', 'wheels'), '-r', path.join(root, 'embedding', 'requirements.lock.txt')])
  run(python, ['-I', '-c', 'import torch,transformers,numpy; assert torch.version.cuda is None; assert torch.__version__ == "2.10.0+cpu"'])
  writeJson(readyFile, { requirementsSha256: info.requirementsSha256, python: '3.12', device: 'cpu' })
}
status('正在配置 Chengmeng 插件和记忆…')
const profile = path.join(home, 'profiles', 'desktop')
const { initProfile } = require(path.join(runtimeModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
const { PROFILE_TEMPLATES } = require(path.join(runtimeModules, '@deepseek-ai', 'dsh-official-bundles', 'lib', 'index.js'))
initProfile(profile, PROFILE_TEMPLATES.web.bundles)
const packageFile = path.join(profile, 'package.json')
const patchFile = path.join(profile, 'cordis.patch.yml')
const profileMarker = path.join(profile, 'chengmeng-desktop-install.json')
const identity = crypto.createHash('sha256').update(info.contentId + root).digest('hex')
let previous
try { previous = JSON.parse(fs.readFileSync(profileMarker, 'utf8')) } catch {}
if (previous?.identity !== identity) {
  const backup = path.join(home, 'integration-backups', `desktop-${Date.now()}`)
  fs.mkdirSync(backup, { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    if (fs.existsSync(path.join(profile, name))) fs.copyFileSync(path.join(profile, name), path.join(backup, name))
  }
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
  pkg.dependencies ||= {}; pkg.dsh ||= {}; pkg.dsh.profile ||= {}
  const bundles = new Set(pkg.dsh.profile.bundles || PROFILE_TEMPLATES.web.bundles)
  for (const module of info.modules) {
    const from = path.join(root, 'plugins', module.directory)
    const to = path.join(profile, 'node_modules', ...module.name.split('/'))
    // Only these six owned module directories are replaced. Unlink junctions
    // themselves rather than following a development checkout's link.
    if (fs.existsSync(to)) {
      const stat = fs.lstatSync(to)
      if (stat.isSymbolicLink()) fs.unlinkSync(to)
      else fs.renameSync(to, path.join(backup, module.directory))
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true })
    pkg.dependencies[module.name] = `link:${from.replaceAll('\\', '/')}`
    bundles.add(module.name)
  }
  pkg.dsh.profile.bundles = [...bundles]
  const yaml = require(path.join(runtimeModules, 'yaml'))
  const old = fs.readFileSync(patchFile, 'utf8')
  const clean = old.replace(/^# BEGIN CHENGMENG DESKTOP\r?\n[\s\S]*?^# END CHENGMENG DESKTOP\r?\n?/gm, '').replace(/^\[\]\s*$/gm, '')
  // Preserve explicit user memory paths/options when upgrading this profile.
  const entries = yaml.parse(old) || []
  const priorMemory = Array.isArray(entries) ? entries.findLast(x => x.id === 'chengmeng-memory-consent')?.config || {} : {}
  const priorFetch = Array.isArray(entries) ? entries.findLast(x => x.id === 'web-fetch-http')?.config || {} : {}
  const own = [
    { id: 'agent-preset-registry', config: { default: 'chengmeng' } },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'ui-settings-account', config: { version: 1, step: 'done', completion: 'skipped' } },
    { id: 'chengmeng-memory-consent', config: { ...priorMemory, backend: 'qwen-hybrid',
      qwen: { ...(priorMemory.qwen || {}), python, modelDir: path.join(root, 'embedding', 'model') } } },
    { id: 'web-fetch-http', config: { ...priorFetch, maxBodyChars: 1000000 } },
  ]
  writeJson(packageFile, pkg)
  fs.writeFileSync(patchFile, clean.trimEnd() + '\n# BEGIN CHENGMENG DESKTOP\n' + yaml.stringify(own) + '# END CHENGMENG DESKTOP\n')
  writeJson(profileMarker, { identity, version: info.version, installed: new Date().toISOString() })
}
status('准备完成，正在打开 Chengmeng…')
