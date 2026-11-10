// Explicit, offline acceptance test with fictional records only.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createQwenEncoder } from '../src/backends/qwen-encoder.js'
import { createQwenBackend } from '../src/backends/qwen.js'
import { createKeywordBackend } from '../src/backends/keyword.js'
import { createHybridBackend } from '../src/backends/hybrid.js'
import { validateConfig } from '../src/config.js'
import { buildRecord } from '../src/model.js'

const project = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const runtime = join(project, '.runtime/qwen-embedding')
const config = { ...validateConfig({}).qwen,
  python: join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), modelDir: join(runtime, 'model') }
const dataDir = await mkdtemp(join(tmpdir(), 'cm-qwen-acceptance-'))
const encoder = createQwenEncoder(config)
let records = [
  '周二上午九点参加软件开发岗位面试，需要提前整理项目经历。',
  '回复尽量简短，先给结论再解释。',
  '不喜欢吃辣，偏好清淡的饭菜。',
  '周末常去公园观察野生鸟类。',
  '租房希望月租不超过两千元，通勤控制在半小时。',
  '正在学习 Python，每晚练习半小时。',
  '周三去医院复诊，带上检查报告。',
  '本月目标是保持规律作息，晚上十一点前睡觉。',
].map((content, i) => ({ ...buildRecord({ content, category: 'preference', sensitivity: i === 6 ? 'sensitive' : 'normal',
  reasons: i === 6 ? ['medical'] : [], source: 'session:fictional-qwen-test#turn:1',
  confirmed_by_user: true, quote_verified: true, clock: () => new Date('2026-11-10T01:00:00Z') }),
  source_time: '2026-11-03T01:00:00.000Z' }))
const qwen = createQwenBackend({ dataDir, config, encoder, getRecords: async () => records })
const keyword = createKeywordBackend({ dataDir })
const hybrid = createHybridBackend({ keyword, memsearch: qwen })
const report = { model: 'Qwen/Qwen3-Embedding-0.6B', device: 'cpu', dimensions: config.dimensions, fictionalDataOnly: true }
try {
  const start = performance.now()
  await hybrid.rebuild(records)
  report.coldIndexEightRecordsMs = Math.round(performance.now() - start)
  report.samples = []
  for (const [query, expected] of [
    ['之前找工作的那件事要准备什么', 0], ['希望你怎样组织回答', 1],
    ['做饭时要避开什么口味', 2], ['住处的费用和上班路程有什么要求', 4],
  ]) {
    const now = performance.now()
    const semantic = await qwen.search(query, { limit: 3, includeSensitive: false })
    const elapsed = Math.round(performance.now() - now)
    const mixed = await hybrid.search(query, { limit: 3, includeSensitive: false })
    report.samples.push({ query, semanticMs: elapsed, semanticHit: semantic.some(x => x.id === records[expected].id),
      hybridHit: mixed.results.some(x => x.id === records[expected].id), scores: semantic.map(x => Number(x.score.toFixed(4))) })
  }
  if (process.platform === 'win32') {
    const command = `$all = @(Get-CimInstance Win32_Process); $taskIds = [System.Collections.Generic.List[int]]::new(); $taskIds.Add(${encoder.processId()}); for($i=0;$i -lt $taskIds.Count;$i++){foreach($p in $all | Where-Object ParentProcessId -eq $taskIds[$i]){$taskIds.Add([int]$p.ProcessId)}}; ($taskIds | ForEach-Object { (Get-Process -Id $_).PeakWorkingSet64 } | Measure-Object -Sum).Sum`
    const bytes = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8' }).trim())
    report.peakWorkerWorkingSetMiB = Math.round(bytes / 1024 / 1024)
  }
  const deleted = records[0]
  records = records.slice(1)
  await hybrid.remove(deleted.id)
  report.deletedVectorRemoved = !JSON.parse(await readFile(join(dataDir, 'index/qwen-vectors.json'), 'utf8')).rows.some(x => x.id === deleted.id)
  report.deletedNotReturned = !(await hybrid.search('之前找工作的那件事', { limit: 8 })).results.some(x => x.id === deleted.id)
  encoder.dispose()
  const missing = createQwenEncoder({ ...config, python: '', modelDir: '' })
  const absent = createQwenBackend({ dataDir, config, encoder: missing, getRecords: async () => records })
  const fallback = await createHybridBackend({ keyword, memsearch: absent }).search('Python', { limit: 5 })
  report.missingModelFallback = fallback.backend_used === 'keyword' && fallback.degraded && fallback.results.length > 0
  const output = join(project, 'docs/verification/qwen-cpu-acceptance.json')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  assert(report.samples.every(sample => sample.hybridHit), 'A fictional paraphrase failed retrieval')
  assert(report.deletedVectorRemoved && report.deletedNotReturned && report.missingModelFallback)
} finally {
  encoder.dispose()
  assert.equal(dirname(dataDir), tmpdir()); assert(basename(dataDir).startsWith('cm-qwen-acceptance-'))
  await rm(dataDir, { recursive: true, force: true })
}
