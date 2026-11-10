/**
 * Markdown 块格式：解析器与序列化器是一对纯函数，往返无损。
 *
 * 格式（规范性示例的微调版，理由见 docs/modules/memory-consent.md 的 ADR-004）：
 *
 * ```text
 * ## mem_<uuid>
 *
 * ```` ````  ← 动态长度的围栏：比内容里最长的连续反引号还长一个，最少 3 个
 * <content 原文，可以多行、可以有空行>
 * ```` ````
 *
 * - category: preference
 * - sensitivity: sensitive
 * ...
 * ```
 *
 * 为什么用围栏而不是直接写段落：content 里可能出现 `## `、`---`、`<!--`、空行、代码围栏、
 * 与元数据行相似的文字、emoji、超长行；围栏是 CommonMark 里唯一能原样收住这些字符的结构。
 * 围栏长度按内容动态变长，所以内容里即使有 ``` 也不会提前闭合。
 *
 * 文件损坏时**不崩溃**：坏块整块交给调用方隔离（切片是从 `## mem_...` 到下一个块之前），
 * 其余块照常返回。隔离文件里保留原文，不丢用户数据。
 */

import {
  CATEGORIES,
  REASONS,
  RECORD_FIELDS,
  SENSITIVITIES,
  isIsoTimestamp,
  isMemoryId,
  isSource,
  validateMemoryRecord,
} from './model.js'

/** 记忆文件名的格式（memory/YYYY-MM-DD.md）。 */
export const MEMORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/

/** 块头：`## mem_<uuid>`。 */
export const BLOCK_HEADER_PATTERN = /^## (mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** 元数据键的顺序（与 RECORD_FIELDS 里可序列化的字段一致，content 不在这里）。 */
export const METADATA_KEYS = Object.freeze([
  'category',
  'sensitivity',
  'reasons',
  'created_at',
  'updated_at',
  'confirmed_by_user',
  'edited_by_user',
  'source',
  'quote_verified',
  'source_time',
  'saved_automatically',
])

/** 派生视图（每次变更后从 memory/ 重新生成；不索引、不手改）。 */
export const VIEW_NAMES = Object.freeze(['profile.md', 'preferences.md', 'goals.md', 'episodes.md', 'open_loops.md'])

/** 取内容里最长的连续反引号长度；围栏要比它更长。 */
export function longestBacktickRun(content) {
  let longest = 0
  let current = 0
  for (const char of content) {
    if (char === '`') {
      current += 1
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return longest
}

/** 内容围栏：最少 3 个反引号，且严格长于内容里最长的连续反引号。 */
export function contentFence(content) {
  return '`'.repeat(Math.max(3, longestBacktickRun(content) + 1))
}

function metadataValue(key, record) {
  switch (key) {
    case 'category':
      return record.category
    case 'sensitivity':
      return record.sensitivity
    case 'reasons':
      return record.reasons.join(', ')
    case 'created_at':
      return record.created_at
    case 'updated_at':
      return record.updated_at
    case 'source_time':
      return record.source_time
    case 'confirmed_by_user':
      return record.confirmed_by_user ? 'true' : 'false'
    case 'edited_by_user':
      return record.edited_by_user ? 'true' : 'false'
    case 'saved_automatically':
      return record.saved_automatically ? 'true' : 'false'
    case 'source':
      return record.source
    case 'quote_verified':
      return record.quote_verified === 'unknown' ? 'unknown' : record.quote_verified ? 'true' : 'false'
    default:
      throw new Error(`未知元数据键 ${key}`)
  }
}

/**
 * 序列化一条记录为一个 Markdown 块（不含末尾换行）。
 * @param {object} record 已校验的记忆记录。
 * @returns {string}
 */
export function serializeBlock(record) {
  const fence = contentFence(record.content)
  const lines = [`## ${record.id}`, '', fence, ...record.content.split('\n'), fence, '']
  for (const key of METADATA_KEYS) {
    if (['source_time', 'saved_automatically'].includes(key) && record[key] === undefined) continue
    lines.push(`- ${key}: ${metadataValue(key, record)}`)
  }
  return lines.join('\n')
}

/**
 * 序列化整个文件。
 * @param {object[]} records
 * @returns {string}
 */
export function serializeDocument(records) {
  if (records.length === 0) return ''
  return `${records.map(serializeBlock).join('\n\n')}\n`
}

function parseBoolean(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function parseMetadataLine(line, metadata) {
  const match = /^- ([a-z_]+):(.*)$/.exec(line)
  if (!match) return { ok: false }
  const key = match[1]
  if (!METADATA_KEYS.includes(key)) return { ok: false }
  if (Object.prototype.hasOwnProperty.call(metadata, key)) return { ok: false, duplicate: true }
  metadata[key] = match[2].startsWith(' ') ? match[2].slice(1) : match[2]
  return { ok: true }
}

function parseMetadata(metadata) {
  for (const key of METADATA_KEYS) {
    if (['source_time', 'saved_automatically'].includes(key)) continue // optional in old memories
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) return { ok: false, reason: `缺少元数据 ${key}` }
  }
  const record = {
    category: metadata.category,
    sensitivity: metadata.sensitivity,
    reasons: metadata.reasons === '' ? [] : metadata.reasons.split(',').map((item) => item.trim()),
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    confirmed_by_user: parseBoolean(metadata.confirmed_by_user),
    edited_by_user: parseBoolean(metadata.edited_by_user),
    source: metadata.source,
    quote_verified: metadata.quote_verified === 'unknown' ? 'unknown' : parseBoolean(metadata.quote_verified),
    ...(metadata.source_time === undefined ? {} : { source_time: metadata.source_time }),
    ...(metadata.saved_automatically === undefined ? {} : { saved_automatically: parseBoolean(metadata.saved_automatically) }),
  }

  if (!CATEGORIES.includes(record.category)) return { ok: false, reason: 'category 取值不合法' }
  if (!SENSITIVITIES.includes(record.sensitivity)) return { ok: false, reason: 'sensitivity 取值不合法' }
  if (record.reasons.some((reason) => !REASONS.includes(reason))) return { ok: false, reason: 'reasons 含未知取值' }
  if (!isIsoTimestamp(record.created_at) || !isIsoTimestamp(record.updated_at)) return { ok: false, reason: '时间戳不合法' }
  if (record.source_time !== undefined && !isIsoTimestamp(record.source_time)) return { ok: false, reason: '来源时间戳不合法' }
  if (record.confirmed_by_user === undefined) return { ok: false, reason: 'confirmed_by_user 不合法' }
  if (record.edited_by_user === undefined) return { ok: false, reason: 'edited_by_user 不合法' }
  if (record.quote_verified === undefined) return { ok: false, reason: 'quote_verified 不合法' }
  if (!isSource(record.source)) return { ok: false, reason: 'source 不合法' }
  return { ok: true, value: record }
}

/**
 * 解析一个块（`## id` 到下一个块之前）。
 * @param {string[]} lines 整个文件按 \n 切好的行。
 * @param {number} start 块头所在行号。
 * @param {number} end 块结束行号（不含）。
 * @returns {{ ok: true, record: object } | { ok: false, reason: string }}
 */
function parseBlock(lines, start, end) {
  const header = BLOCK_HEADER_PATTERN.exec(lines[start])
  if (!header) return { ok: false, reason: '块头格式不正确' }
  const id = header[1]

  let index = start + 1
  while (index < end && lines[index].trim() === '') index += 1
  if (index >= end) return { ok: false, reason: '缺少内容围栏' }

  const opening = /^(`{3,})\s*$/.exec(lines[index])
  if (!opening) return { ok: false, reason: '缺少内容围栏' }
  const fenceLength = opening[1].length
  index += 1

  const contentLines = []
  let closed = false
  while (index < end) {
    const closing = /^(`{3,})\s*$/.exec(lines[index])
    if (closing && closing[1].length >= fenceLength) {
      closed = true
      index += 1
      break
    }
    contentLines.push(lines[index])
    index += 1
  }
  if (!closed) return { ok: false, reason: '内容围栏没有闭合' }

  const metadata = {}
  while (index < end) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }
    const parsed = parseMetadataLine(line, metadata)
    if (!parsed.ok) return { ok: false, reason: '元数据行格式不正确' }
    index += 1
  }

  const checked = parseMetadata(metadata)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const record = { id, content: contentLines.join('\n'), ...checked.value }
  return { ok: true, record }
}

const FENCE_LINE = /^(`{3,})\s*$/

/**
 * 找下一个**在围栏之外**的块头。围栏内的 `## mem_...` 只是内容，不是块头。
 * @param {string[]} lines
 * @param {number} from 从哪一行开始找。
 * @returns {number} 行号；找不到返回 -1。
 */
export function findNextHeaderOutsideFence(lines, from) {
  let fence = 0
  for (let index = from; index < lines.length; index++) {
    const line = lines[index]
    if (fence === 0) {
      if (BLOCK_HEADER_PATTERN.test(line)) return index
      const opening = FENCE_LINE.exec(line)
      if (opening) fence = opening[1].length
      continue
    }
    const closing = FENCE_LINE.exec(line)
    if (closing && closing[1].length >= fence) fence = 0
  }
  return -1
}

/**
 * 解析整个 Markdown 文件。
 * @param {string} text
 * @param {{ maxContentChars?: number }} [options]
 * @returns {{ records: object[], quarantined: { reason: string, raw: string }[] }}
 */
export function parseDocument(text, options = {}) {
  const maxContentChars = options.maxContentChars ?? 280
  const source = typeof text === 'string' ? text : ''
  const lines = source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

  const records = []
  const quarantined = []
  const seenIds = new Set()

  const firstHeader = findNextHeaderOutsideFence(lines, 0)
  if (firstHeader < 0) {
    if (source.trim() !== '') quarantined.push({ reason: '文件中没有可识别的记忆块', raw: source.trim() })
    return { records, quarantined }
  }
  // 块头之前如果有非空内容，也算损坏内容，一起隔离，不能悄悄丢掉。
  const preamble = lines.slice(0, firstHeader).join('\n')
  if (preamble.trim() !== '') quarantined.push({ reason: '块头之前有无法识别的内容', raw: preamble.trim() })

  let start = firstHeader
  while (start >= 0) {
    const next = findNextHeaderOutsideFence(lines, start + 1)
    const end = next >= 0 ? next : lines.length
    const raw = lines.slice(start, end).join('\n').replace(/\s+$/, '')
    const parsed = parseBlock(lines, start, end)
    if (!parsed.ok) {
      quarantined.push({ reason: parsed.reason, raw })
    } else {
      const record = parsed.record
      if (seenIds.has(record.id)) {
        quarantined.push({ reason: '重复的 id', raw })
      } else {
        const checked = validateMemoryRecord(record, { maxContentChars })
        if (!checked.ok) {
          quarantined.push({ reason: '字段校验失败', raw })
        } else {
          seenIds.add(record.id)
          records.push(checked.value)
        }
      }
    }
    start = next
  }

  return { records, quarantined }
}

function escapeInline(text) {
  // 派生视图是给人看的，不是事实来源；这里只避免反引号和换行破坏行内代码。
  return text.replace(/`/g, '\\`').replace(/\n/g, ' ')
}

function renderList(records, title, introduction) {
  const lines = [`# ${title}`, '', `> 本文件由 chengmeng-memory-consent 从 memory/ 派生，每次变更后重新生成；不要手改。`, '']
  if (introduction) lines.push(introduction, '')
  if (records.length === 0) {
    lines.push('_还没有记录。_', '')
    return lines.join('\n')
  }
  for (const record of records) {
    lines.push(`- ${escapeInline(record.content)}  `)
    lines.push(`  \`${record.id}\` · ${record.created_at.slice(0, 10)}`)
  }
  lines.push('')
  return lines.join('\n')
}

function sortByCreatedAt(records) {
  return [...records].sort((left, right) => {
    if (left.created_at === right.created_at) return left.id.localeCompare(right.id)
    return left.created_at.localeCompare(right.created_at)
  })
}

/**
 * 从记忆记录生成派生视图。视图不索引、不手改，删掉也会重新生成。
 * @param {object[]} records
 * @returns {Record<string, string>} 文件名 → 内容
 */
export function renderViews(records) {
  const sorted = sortByCreatedAt(records)
  const byCategory = (category) => sorted.filter((record) => record.category === category)

  return {
    'profile.md': renderList(sorted, '用户画像（派生视图）', '全部已确认记忆的概览，按创建时间排序。'),
    'preferences.md': renderList(byCategory('preference'), '偏好', '用户明确说过的长期偏好。'),
    'goals.md': renderList(byCategory('goal'), '目标', '用户当前想做的事。'),
    'episodes.md': renderList(byCategory('episode'), '重要经历', '对以后有用的经历。'),
    'open_loops.md': renderList(byCategory('open_loop'), '未解决的事', '还没有了结的问题。'),
  }
}

/** 供 JSON 序列化前做浅拷贝的工具（不导出内部 Map）。 */
export function recordToJson(record) {
  const output = {}
  for (const field of RECORD_FIELDS) output[field] = record[field]
  return output
}
