import { spawn, execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freemem } from 'node:os'

export const QWEN_MODEL = 'Qwen/Qwen3-Embedding-0.6B'
export const QWEN_REVISION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'
const workerPath = fileURLToPath(new URL('../../python/qwen_worker.py', import.meta.url))
const failure = code => Object.assign(new Error(code), { code })

/** Lazy CPU worker; user text travels only in stdin, never process arguments. */
export function createQwenEncoder(config, { spawnImpl = spawn, freeMemory = freemem } = {}) {
  let child = null, pending = null, buffer = '', counter = 0, idleTimer = null
  let disposed = false, running = false, lastError = null, tail = Promise.resolve()
  function stop(code = 'QWEN_STOPPED') {
    clearTimeout(idleTimer)
    const old = child
    child = null; running = false; buffer = ''
    if (pending) { pending.reject(failure(code)); pending = null }
    if (old) {
      old.stdin.destroy()
      // Windows venv python.exe is a redirector with a child interpreter.
      // Stop only this spawned process tree, including on timeout or idle release.
      if (process.platform === 'win32' && Number.isInteger(old.pid) && old.exitCode === null) {
        execFile('taskkill.exe', ['/PID', String(old.pid), '/T', '/F'], { windowsHide: true }, () => {})
      } else old.kill()
    }
  }
  async function health() {
    let available = false
    if (config.python && config.modelDir) {
      available = await Promise.all([config.python, join(config.modelDir, 'model.safetensors'),
        join(config.modelDir, 'config.json'), join(config.modelDir, 'tokenizer.json')]
        .map(path => access(path).then(() => true, () => false))).then(values => values.every(Boolean))
    }
    const enoughMemory = running || freeMemory() >= (config.minFreeMemoryMb ?? 4096) * 1024 * 1024
    return { ok: available && enoughMemory && !lastError, configured: available, running, model: QWEN_MODEL,
      device: 'cpu', dimensions: config.dimensions,
      reason: !available ? 'model_or_runtime_missing' : !enoughMemory ? 'insufficient_memory' : lastError }
  }
  function launch() {
    const args = ['-I', '-u', workerPath, '--model-dir', config.modelDir, '--dimensions', String(config.dimensions),
      '--threads', String(config.threads), '--max-tokens', String(config.maxTokens)]
    const proc = spawnImpl(config.python, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        DO_NOT_TRACK: '1', TOKENIZERS_PARALLELISM: 'false', CUDA_VISIBLE_DEVICES: '' } })
    child = proc
    proc.stdout.setEncoding('utf8')
    proc.stderr.on('data', () => {}) // drain; never propagate library diagnostics or input
    proc.on('error', () => { if (child === proc) { lastError = 'QWEN_START_FAILED'; stop(lastError) } })
    proc.on('exit', () => { if (child === proc) { lastError = 'QWEN_EXITED'; stop(lastError) } })
    proc.stdin.on('error', () => { if (child === proc) stop('QWEN_PIPE_FAILED') })
    proc.stdout.on('data', chunk => {
      if (child !== proc) return
      buffer += chunk
      if (buffer.length > 2 * 1024 * 1024) return stop('QWEN_OUTPUT_TOO_LARGE')
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let message
        try { message = JSON.parse(line) } catch { return stop('QWEN_BAD_OUTPUT') }
        if (!pending || message.id !== pending.id) return stop('QWEN_BAD_OUTPUT')
        const current = pending; pending = null
        if (!message.ok) { lastError = 'QWEN_INFERENCE_FAILED'; current.reject(failure(lastError)) }
        else { running = true; lastError = null; current.resolve(message.vectors) }
      }
    })
  }
  async function run(texts, kind, signal) {
    if (disposed) throw failure('QWEN_DISPOSED')
    if (signal?.aborted) throw Object.assign(failure('QWEN_ABORTED'), { name: 'AbortError' })
    if (!(await health()).configured) throw failure('QWEN_UNAVAILABLE')
    if (!child && freeMemory() < (config.minFreeMemoryMb ?? 4096) * 1024 * 1024) throw failure('QWEN_LOW_MEMORY')
    clearTimeout(idleTimer)
    if (!child) launch()
    const id = ++counter
    let timeout, onAbort
    try {
      const vectors = await new Promise((resolve, reject) => {
        pending = { id, resolve, reject }
        timeout = setTimeout(() => { lastError = 'QWEN_TIMEOUT'; stop(lastError) }, config.timeoutMs)
        onAbort = () => stop('QWEN_ABORTED')
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) return onAbort()
        child.stdin.write(JSON.stringify({ id, kind, texts }) + '\n', 'utf8', error => {
          if (error && pending?.id === id) stop('QWEN_PIPE_FAILED')
        })
      })
      if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(v => !Array.isArray(v)
        || v.length !== config.dimensions || v.some(n => !Number.isFinite(n)))) throw failure('QWEN_BAD_VECTOR')
      return vectors
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', onAbort)
      idleTimer = setTimeout(() => stop(), config.idleMs); idleTimer.unref?.()
    }
  }
  return {
    health,
    processId: () => child?.pid,
    encode(texts, { kind = 'document', signal } = {}) {
      const result = tail.then(() => run(texts, kind, signal))
      tail = result.catch(() => {})
      return result
    },
    dispose() { disposed = true; stop() },
  }
}
