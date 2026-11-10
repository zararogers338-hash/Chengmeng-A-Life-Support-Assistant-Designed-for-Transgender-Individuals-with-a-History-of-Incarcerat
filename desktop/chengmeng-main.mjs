// Local distribution entry. The upstream runtime and account flow stay intact.
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const home = process.env.DSH_HOME
if (!home) throw new Error('Please start Chengmeng using Chengmeng.exe.')
const uiHome = join(resolve(home), 'desktop-ui')
mkdirSync(uiHome, { recursive: true })
app.setPath('userData', uiHome)
app.setName('Chengmeng')
app.setAppUserModelId('local.chengmeng.desktop')
// This independently updated distribution has no upstream update-policy view.
// The stock preload explicitly supports an undefined initial state.
ipcMain.handle('dsh-desktop:mandatory-status', () => undefined)
const marker = join(home, 'run', 'chengmeng-desktop.json')
app.on('browser-window-created', (_event, window) => {
  window.on('page-title-updated', event => { event.preventDefault(); window.setTitle('Chengmeng') })
})
app.on('will-quit', () => {
  try { if (JSON.parse(readFileSync(marker, 'utf8')).pid === process.pid) unlinkSync(marker) } catch {}
})
// The upstream entry claims its single-instance lock before app readiness.
await import('./lib/main.js')
if (app.hasSingleInstanceLock()) {
  app.whenReady().then(() => {
    if (!app.hasSingleInstanceLock()) return
    mkdirSync(join(home, 'run'), { recursive: true })
    writeFileSync(marker, JSON.stringify({ pid: process.pid, executable: process.execPath, started: new Date().toISOString() }))
    for (const window of BrowserWindow.getAllWindows()) window.setTitle('Chengmeng')
  })
}
