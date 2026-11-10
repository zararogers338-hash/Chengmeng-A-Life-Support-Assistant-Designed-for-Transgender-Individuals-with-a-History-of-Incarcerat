import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from '../atomic.js'
import { withinMemoryRange } from '../time-range.js'
import { isSavedMemory } from '../model.js'
import { createQwenEncoder, QWEN_MODEL, QWEN_REVISION } from './qwen-encoder.js'

const error = code => Object.assign(new Error(code), { code })
const contentHash = text => createHash('sha256').update(text).digest('hex')
function pack(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(n => !Number.isFinite(n))) throw error('QWEN_BAD_VECTOR')
  const norm = Math.hypot(...vector)
  if (!(norm > 0)) throw error('QWEN_BAD_VECTOR')
  const bytes = Buffer.alloc(dimensions * 4)
  vector.forEach((n, i) => bytes.writeFloatLE(n / norm, i * 4))
  return bytes.toString('base64')
}
function similarity(encoded, query) {
  const bytes = Buffer.from(encoded, 'base64')
  let score = 0
  for (let i = 0; i < query.length; i++) score += bytes.readFloatLE(i * 4) * query[i]
  return score
}

/** Exact cosine index for single-user memories; plaintext stays in Markdown. */
export function createQwenBackend({ dataDir, config, getRecords, encoder = createQwenEncoder(config), clock = () => Date.now(), authorized = isSavedMemory }) {
  const indexPath = join(dataDir, 'index', 'qwen-vectors.json')
  const fingerprint = contentHash(JSON.stringify({ model: QWEN_MODEL, revision: QWEN_REVISION,
    path: resolve(config.modelDir || '.'), dimensions: config.dimensions, maxTokens: config.maxTokens, pooling: 'last-token-v1' }))
  let rows = new Map(), loaded = false, dirty = false, retryAfter = 0, lastError = null, tail = Promise.resolve()
  const serial = fn => (...args) => {
    const task = tail.then(() => fn(...args)); tail = task.catch(() => {}); return task
  }
  async function load() {
    if (loaded) {
      if (rows.size && !(await stat(indexPath).then(() => true, () => false))) dirty = true
      return
    }
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
      if (parsed.version !== 1 || parsed.fingerprint !== fingerprint || !Array.isArray(parsed.rows)) throw error('QWEN_INDEX_STALE')
      for (const row of parsed.rows) {
        const bytes = Buffer.from(row.vector || '', 'base64')
        if (typeof row.id !== 'string' || typeof row.hash !== 'string' || bytes.length !== config.dimensions * 4) throw error('QWEN_INDEX_INVALID')
        for (let i = 0; i < config.dimensions; i++) if (!Number.isFinite(bytes.readFloatLE(i * 4))) throw error('QWEN_INDEX_INVALID')
        rows.set(row.id, row)
      }
    } catch { rows = new Map(); dirty = true }
  }
  async function persist() {
    if (!dirty) return
    await atomicWriteFile(indexPath, JSON.stringify({ version: 1, fingerprint, model: QWEN_MODEL,
      revision: QWEN_REVISION, dimensions: config.dimensions, rows: [...rows.values()] }))
    dirty = false
  }
  function entry(record, vector) {
    return { id: record.id, hash: contentHash(record.content), vector, category: record.category,
      sensitivity: record.sensitivity, created_at: record.created_at, source_time: record.source_time }
  }
  async function embed(records, signal) {
    if (clock() < retryAfter) throw error('QWEN_RETRY_LATER')
    try {
      const vectors = await encoder.encode(records.map(record => record.content), { kind: 'document', signal })
      records.forEach((record, i) => { rows.set(record.id, entry(record, pack(vectors[i], config.dimensions))); dirty = true })
      lastError = null; retryAfter = 0
    } catch (e) { lastError = 'semantic_unavailable'; retryAfter = clock() + 30000; throw error('QWEN_UNAVAILABLE') }
  }
  async function sync(records, signal) {
    await load()
    const truth = new Map(records.filter(authorized).map(record => [record.id, record]))
    for (const [id, row] of rows) {
      if (!truth.has(id) || row.hash !== contentHash(truth.get(id).content)) { rows.delete(id); dirty = true }
    }
    // Remove stale vectors before model work, so a model failure cannot retain deleted data.
    if (dirty && (rows.size || await stat(indexPath).then(() => true, () => false))) await persist()
    const missing = []
    for (const record of truth.values()) {
      if (!rows.has(record.id)) missing.push(record)
      else {
        const next = entry(record, rows.get(record.id).vector)
        if (JSON.stringify(next) !== JSON.stringify(rows.get(record.id))) { rows.set(record.id, next); dirty = true }
      }
    }
    for (let i = 0; i < missing.length; i += config.batchSize) {
      if (signal?.aborted) throw error('QWEN_ABORTED')
      await embed(missing.slice(i, i + config.batchSize), signal)
      await persist()
    }
    if (rows.size || await stat(indexPath).then(() => true, () => false)) await persist()
  }
  return {
    name: 'qwen',
    add: serial(async record => {
      if (!authorized(record)) throw error('UNCONFIRMED_MEMORY')
      await load()
      // Never retain a vector of old content if replacement embedding fails.
      if (rows.has(record.id)) { rows.delete(record.id); dirty = true; await persist() }
      await embed([record]); await persist()
    }),
    remove: serial(async id => { await load(); rows.delete(id); dirty = true; await persist() }),
    rebuild: serial(async records => { await sync(records); return { ok: true, docs: rows.size } }),
    search: serial(async (query, options = {}) => {
      const available = await encoder.health()
      if (available.configured === false || clock() < retryAfter) throw error('QWEN_UNAVAILABLE')
      await sync(await getRecords(), options.signal)
      const candidates = [...rows.values()].filter(row => withinMemoryRange(row, options))
      if (!candidates.length) return []
      let vector
      try {
        const [value] = await encoder.encode([query], { kind: 'query', signal: options.signal })
        const bytes = Buffer.from(pack(value, config.dimensions), 'base64')
        vector = Array.from({ length: config.dimensions }, (_, i) => bytes.readFloatLE(i * 4))
        lastError = null; retryAfter = 0
      } catch { lastError = 'semantic_unavailable'; retryAfter = clock() + 30000; throw error('QWEN_UNAVAILABLE') }
      return candidates.map(row => ({ id: row.id, score: similarity(row.vector, vector), matched_by: 'semantic' }))
        .filter(hit => hit.score >= config.minScore)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.limit ?? 8)
    }),
    async health() { const state = await encoder.health(); return { ...state, ok: state.ok && !lastError,
      backend: 'qwen', docs: rows.size, reason: state.reason || lastError } },
    isIndexed: () => stat(indexPath).then(() => true, () => false),
    dispose: () => encoder.dispose(),
  }
}
