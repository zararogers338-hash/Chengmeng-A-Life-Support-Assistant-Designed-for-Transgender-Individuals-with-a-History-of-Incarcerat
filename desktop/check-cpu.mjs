// Real inference smoke test. Synthetic strings never enter the user's memory.
import { createQwenEncoder } from '../plugins/memory-consent/src/backends/qwen-encoder.js'
import { resolve, join } from 'node:path'
const root = resolve(process.argv[2] || '.desktop-build/stage')
const encoder = createQwenEncoder({ python: join(root, 'embedding/venv/Scripts/python.exe'),
  modelDir: join(root, 'embedding/model'), dimensions: 1024, threads: 4, maxTokens: 2048,
  timeoutMs: 120000, idleMs: 2000, minFreeMemoryMb: 0 })
try {
  const start = performance.now()
  const vectors = await encoder.encode(['测试夹具：周末去公园看了松树。', '测试夹具：如何更换键盘的键帽？'], { kind: 'document' })
  if (vectors.length !== 2 || vectors.some(v => v.length !== 1024 || Math.abs(Math.hypot(...v) - 1) > 0.001)) throw new Error('Invalid normalized vectors')
  console.log(JSON.stringify({ ok: true, device: 'cpu', dimensions: 1024, documents: vectors.length, elapsedMs: Math.round(performance.now() - start) }))
} finally { await encoder.dispose() }
