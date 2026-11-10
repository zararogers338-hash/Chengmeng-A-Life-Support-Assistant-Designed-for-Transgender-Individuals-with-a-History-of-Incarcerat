import { createHash } from 'node:crypto'
import { isSavedMemory } from './model.js'

export const RELATIVE_PERIODS = ['today', 'yesterday', 'this_week', 'last_week']
export function memoryTime(record, field = 'source') {
  return field === 'created' ? record.created_at : (record.source_time || record.created_at)
}
export function withinMemoryRange(record, options = {}) {
  if (options.categories?.length && !options.categories.includes(record.category)) return false
  const time = Date.parse(memoryTime(record, options.timeField))
  if (options.since && (!Number.isFinite(time) || time < Date.parse(options.since))) return false
  if (options.until && (!Number.isFinite(time) || time > Date.parse(options.until))) return false
  return true
}

function dateParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]))
}
function localMidnight(ymd, timeZone) {
  const wall = Date.UTC(ymd.getUTCFullYear(), ymd.getUTCMonth(), ymd.getUTCDate())
  let instant = wall
  for (let i = 0; i < 4; i++) {
    const p = dateParts(new Date(instant), timeZone)
    const displayed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const delta = wall - displayed
    if (!delta) return instant
    instant += delta
  }
  throw new Error('TIME_RANGE_UNRESOLVED')
}
/** Calendar periods in the configured IANA zone; weeks start on Monday. */
export function resolvePeriod(period, now = new Date(), timeZone = 'Asia/Shanghai') {
  if (!RELATIVE_PERIODS.includes(period)) throw new Error('INVALID_PERIOD')
  const p = dateParts(now, timeZone)
  const start = new Date(Date.UTC(p.year, p.month - 1, p.day))
  if (period === 'yesterday') start.setUTCDate(start.getUTCDate() - 1)
  if (period.endsWith('week')) {
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7 - (period === 'last_week' ? 7 : 0))
  }
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + (period.endsWith('week') ? 7 : 1))
  return { since: new Date(localMidnight(start, timeZone)).toISOString(),
    until: new Date(localMidnight(end, timeZone) - 1).toISOString(), time_zone: timeZone }
}

/** Exhaustive, paged chronological recall; never substitutes vector top-k. */
export function timelinePage(records, options, { authorized = isSavedMemory } = {}) {
  const selected = records.filter(record => authorized(record) && withinMemoryRange(record, options))
    .sort((a, b) => memoryTime(a, options.timeField).localeCompare(memoryTime(b, options.timeField)) || a.id.localeCompare(b.id))
  const fingerprint = createHash('sha256').update(JSON.stringify({
    since: options.since, until: options.until, categories: options.categories,
    private: options.includeSensitive, field: options.timeField,
    records: selected.map(record => [record.id, record.updated_at, memoryTime(record, options.timeField), record.content, record.sensitivity, record.category]),
  })).digest('hex')
  let offset = 0
  if (options.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
      if (cursor.fingerprint !== fingerprint || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > selected.length) {
        return { status: 'stale_cursor', message: '记忆或筛选范围已变化，从第一页重新查询。', results: [] }
      }
      offset = cursor.offset
    } catch { return { status: 'invalid', message: '分页标记无效。', results: [] } }
  }
  const page = []
  let characters = 0
  for (const record of selected.slice(offset, offset + options.limit)) {
    const cost = record.content.length + 512
    if (page.length && characters + cost > 6000) break
    page.push(record); characters += cost
  }
  const results = page.map(record => ({ ...record,
    time_basis: options.timeField === 'created' ? 'memory_created' : record.source_time ? 'source_message' : 'memory_created_fallback',
    matched_by: 'timeline',
  }))
  const next = offset + results.length
  return { status: results.length ? 'ok' : 'empty', results, backend_used: 'timeline', degraded: false,
    total: selected.length, has_more: next < selected.length,
    next_cursor: next < selected.length ? Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString('base64url') : null,
    scope: 'saved_memories', since: options.since, until: options.until,
    fallback_time_count: selected.filter(record => !record.source_time).length }
}
