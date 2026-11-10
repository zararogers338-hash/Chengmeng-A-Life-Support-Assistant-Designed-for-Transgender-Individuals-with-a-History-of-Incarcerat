/**
 * 数据模型与严格校验。
 *
 * 候选（pending）与记忆（memory）用同一套字段，区别只有两点：
 * - 候选在 `pending/<id>.json` 里，多一个 status 字段（pending | expired），confirmed_by_user 一律 false；
 * - 记忆在 `memory/YYYY-MM-DD.md` 里，confirmed_by_user 一律 true。
 *
 * 校验规则（提示词 §4.2）：未知字段直接拒绝，类型和枚举不对直接拒绝。
 * 本文件是纯函数，不 import DSH、不碰文件系统。
 */

import { randomUUID } from 'node:crypto'

/** 记忆类别。 */
export const CATEGORIES = Object.freeze(['preference', 'goal', 'episode', 'open_loop', 'explicit'])

/** 类别中文名（只给管理界面用，不出现在待确认卡片上）。 */
export const CATEGORY_LABELS = Object.freeze({
  preference: '偏好',
  goal: '目标',
  episode: '重要经历',
  open_loop: '未解决的事',
  explicit: '明确要求记住',
})

/** 敏感度只有两档：普通、敏感。 */
export const SENSITIVITIES = Object.freeze(['normal', 'sensitive'])

/** 敏感原因取值（提示词 §5.1）。 */
export const REASONS = Object.freeze([
  'gender_identity',
  'sexual_orientation',
  'medical',
  'mental_health',
  'incarceration',
  'trauma',
  'domestic_violence',
  'precise_location',
  'family',
  'other_private',
])

/** 敏感原因中文名（只给管理界面用）。 */
export const REASON_LABELS = Object.freeze({
  gender_identity: '身份认同',
  sexual_orientation: '性取向',
  medical: '医疗健康',
  mental_health: '心理状态',
  incarceration: '司法经历',
  trauma: '创伤经历',
  domestic_violence: '家庭安全',
  precise_location: '具体位置',
  family: '家庭关系',
  other_private: '其他私人信息',
})

/** quote_verified 的取值：true | false | 'unknown'（未核实到会话读取接口时）。 */
export const QUOTE_VERIFIED_VALUES = Object.freeze([true, false, 'unknown'])

/** 仅候选才有的 status。 */
export const PENDING_STATUSES = Object.freeze(['pending', 'expired'])

/** 记忆记录（以及候选）的全部字段，顺序就是 Markdown 元数据行的顺序。 */
export const RECORD_FIELDS = Object.freeze([
  'id',
  'content',
  'category',
  'sensitivity',
  'reasons',
  'source',
  'quote_verified',
  'created_at',
  'updated_at',
  'confirmed_by_user',
  'edited_by_user',
  'source_time',
  'saved_automatically',
])

/** 候选比记忆多一个 status。 */
export const PENDING_FIELDS = Object.freeze([...RECORD_FIELDS, 'status'])

/** 单条记忆的 id 前缀。 */
export const ID_PREFIX = 'mem_'

const ID_PATTERN = /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
// `session:<id>#turn:<n>`；取不到会话信息时允许退化成 `session:unknown`（提示词 §4.2）。
const SOURCE_PATTERN = /^(?:session:unknown|session:[^#\s]+#turn:\d+)$/

/** Automatically saved material is retrievable without claiming per-item user confirmation. */
export function isSavedMemory(record) {
  return record?.confirmed_by_user === true || record?.saved_automatically === true
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 生成一个记忆 id。 */
export function newMemoryId() {
  return `${ID_PREFIX}${randomUUID()}`
}

/** 按 Unicode 码点计算长度（emoji 算一个字符）。 */
export function charLength(text) {
  return Array.from(text).length
}

/**
 * 规范化候选文字：统一换行、去掉首尾空白。内部空白（含空行）原样保留，
 * 所以写入 Markdown 后能无损往返。
 * @param {string} raw
 */
export function normalizeContent(raw) {
  return raw.replace(/\r\n?/g, '\n').trim()
}

/** 当前时间的 ISO 8601 UTC 字符串；clock 可注入，测试用。 */
export function nowIso(clock = () => new Date()) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}

/** 判断字符串是不是我们写出去的 ISO 8601 UTC 时间戳。 */
export function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

/** 校验 id；不合法返回 false。 */
export function isMemoryId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/** 校验 source（`session:<id>#turn:<n>`，取不到会话时 `session:unknown`）。 */
export function isSource(value) {
  return typeof value === 'string' && SOURCE_PATTERN.test(value)
}

function fail(error) {
  return { ok: false, error }
}

function validateContent(content, maxContentChars) {
  if (typeof content !== 'string') return fail('content 必须是字符串')
  const normalized = normalizeContent(content)
  if (normalized === '') return fail('content 不能为空')
  if (charLength(normalized) > maxContentChars) return fail(`content 不能超过 ${maxContentChars} 个字符`)
  if (normalized.includes('\u0000')) return fail('content 不能包含 NUL 字符')
  return { ok: true, value: normalized }
}

function validateEnum(value, allowed, name) {
  if (!allowed.includes(value)) return fail(`${name} 只能是 ${allowed.join(' | ')}`)
  return { ok: true, value }
}

function validateReasons(reasons) {
  if (!Array.isArray(reasons)) return fail('reasons 必须是数组')
  if (reasons.some((reason) => !REASONS.includes(reason))) return fail('reasons 含未知取值')
  const unique = []
  for (const reason of reasons) if (!unique.includes(reason)) unique.push(reason)
  return { ok: true, value: unique }
}

function validateQuoteVerified(value) {
  if (value === 'unknown') return { ok: true, value: 'unknown' }
  if (value === true || value === false) return { ok: true, value }
  return fail("quote_verified 只能是 true | false | 'unknown'")
}

/**
 * 校验一条完整记录（候选或记忆）。
 * @param {unknown} record
 * @param {{ maxContentChars: number, kind?: 'memory'|'pending' }} options
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateRecord(record, options) {
  const { maxContentChars, kind = 'memory' } = options ?? {}
  if (!Number.isInteger(maxContentChars) || maxContentChars < 1) throw new Error('validateRecord 需要 maxContentChars')
  if (!isPlainObject(record)) return fail('记录必须是对象')

  const allowed = kind === 'pending' ? PENDING_FIELDS : RECORD_FIELDS
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return fail(`记录里有未知字段 ${unknown.join(', ')}`)

  if (!isMemoryId(record.id)) return fail('id 格式不正确')

  const content = validateContent(record.content, maxContentChars)
  if (!content.ok) return content

  const category = validateEnum(record.category, CATEGORIES, 'category')
  if (!category.ok) return category
  const sensitivity = validateEnum(record.sensitivity, SENSITIVITIES, 'sensitivity')
  if (!sensitivity.ok) return sensitivity

  const reasons = validateReasons(record.reasons)
  if (!reasons.ok) return reasons
  if (sensitivity.value === 'normal' && reasons.value.length > 0) return fail('normal 记录的 reasons 必须为空')

  const quoteVerified = validateQuoteVerified(record.quote_verified)
  if (!quoteVerified.ok) return quoteVerified

  if (!isSource(record.source)) return fail('source 格式不正确')
  if (!isIsoTimestamp(record.created_at)) return fail('created_at 必须是 ISO 8601 UTC 时间')
  if (!isIsoTimestamp(record.updated_at)) return fail('updated_at 必须是 ISO 8601 UTC 时间')
  if (record.source_time !== undefined && !isIsoTimestamp(record.source_time)) return fail('source_time 必须是 ISO 8601 UTC 时间')
  if (typeof record.confirmed_by_user !== 'boolean') return fail('confirmed_by_user 必须是布尔值')
  if (typeof record.edited_by_user !== 'boolean') return fail('edited_by_user 必须是布尔值')
  if (record.saved_automatically !== undefined && typeof record.saved_automatically !== 'boolean') return fail('saved_automatically 必须是布尔值')

  if (kind === 'memory') {
    if (!isSavedMemory(record)) return fail('写入 memory/ 的记录必须已确认或已自动保存')
  } else {
    if (record.confirmed_by_user !== false) return fail('候选的 confirmed_by_user 必须为 false')
    if (record.saved_automatically === true) return fail('候选不能已自动保存')
    const status = validateEnum(record.status, PENDING_STATUSES, 'status')
    if (!status.ok) return status
  }

  const value = {
    id: record.id,
    content: content.value,
    category: category.value,
    sensitivity: sensitivity.value,
    reasons: reasons.value,
    source: record.source,
    quote_verified: quoteVerified.value,
    created_at: record.created_at,
    updated_at: record.updated_at,
    confirmed_by_user: record.confirmed_by_user,
    edited_by_user: record.edited_by_user,
    ...(record.source_time === undefined ? {} : { source_time: record.source_time }),
    ...(record.saved_automatically === undefined ? {} : { saved_automatically: record.saved_automatically }),
  }
  if (kind === 'pending') value.status = record.status
  return { ok: true, value }
}

/** 校验一条已确认记忆。 */
export function validateMemoryRecord(record, options) {
  return validateRecord(record, { ...options, kind: 'memory' })
}

/** 校验一条待确认候选。 */
export function validatePendingRecord(record, options) {
  return validateRecord(record, { ...options, kind: 'pending' })
}

/**
 * 构造一条新记录（候选或直接写入的记忆由调用方决定 confirmed 值）。
 * @param {{ content: string, category: string, sensitivity: string, reasons: string[], source: string, quote_verified: true|false|'unknown', clock?: () => Date, confirmed_by_user?: boolean, edited_by_user?: boolean }} input
 */
export function buildRecord(input) {
  const timestamp = nowIso(input.clock)
  return {
    id: newMemoryId(),
    content: normalizeContent(input.content),
    category: input.category,
    sensitivity: input.sensitivity,
    reasons: [...input.reasons],
    source: input.source,
    quote_verified: input.quote_verified,
    created_at: timestamp,
    updated_at: timestamp,
    confirmed_by_user: input.confirmed_by_user === true,
    edited_by_user: input.edited_by_user === true,
    ...(input.source_time === undefined ? {} : { source_time: input.source_time }),
    ...(input.saved_automatically === undefined ? {} : { saved_automatically: input.saved_automatically }),
  }
}

/**
 * 校验 propose_memory 的入参。
 *
 * 注意分工：`user_quote` / `stated_by_user` 的**缺失或 false** 属于策略拒绝（rejected_by_policy）而不是格式错误，
 * 所以这里只在"给了但类型/长度不对"时报 invalid；缺字段交给 policy 决定。
 * @param {unknown} args
 * @param {{ maxContentChars: number }} options
 * @returns {{ ok: true, value: { content: string, category: string, sensitivity_hint: 'normal'|'sensitive', user_quote: string|undefined, stated_by_user: boolean|undefined } } | { ok: false, error: string, code: 'invalid' }}
 */
export function validateProposalArgs(args, options) {
  const { maxContentChars } = options ?? {}
  if (!Number.isInteger(maxContentChars) || maxContentChars < 1) throw new Error('validateProposalArgs 需要 maxContentChars')
  if (!isPlainObject(args)) return { ok: false, error: '参数必须是对象', code: 'invalid' }

  const allowed = ['content', 'category', 'sensitivity_hint', 'user_quote', 'stated_by_user']
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) return { ok: false, error: `未知参数 ${unknown.join(', ')}`, code: 'invalid' }

  const content = validateContent(args.content, maxContentChars)
  if (!content.ok) return { ok: false, error: content.error, code: 'invalid' }

  const category = validateEnum(args.category, CATEGORIES, 'category')
  if (!category.ok) return { ok: false, error: category.error, code: 'invalid' }

  let sensitivityHint = 'normal'
  if (args.sensitivity_hint !== undefined) {
    const checked = validateEnum(args.sensitivity_hint, SENSITIVITIES, 'sensitivity_hint')
    if (!checked.ok) return { ok: false, error: checked.error, code: 'invalid' }
    sensitivityHint = checked.value
  }

  let userQuote
  if (args.user_quote !== undefined && args.user_quote !== null) {
    if (typeof args.user_quote !== 'string') return { ok: false, error: 'user_quote 必须是字符串', code: 'invalid' }
    const quote = args.user_quote.replace(/\r\n?/g, '\n').trim()
    if (charLength(quote) > 120) return { ok: false, error: 'user_quote 不能超过 120 个字符', code: 'invalid' }
    userQuote = quote
  }

  let statedByUser
  if (args.stated_by_user !== undefined && args.stated_by_user !== null) {
    if (typeof args.stated_by_user !== 'boolean') return { ok: false, error: 'stated_by_user 必须是布尔值', code: 'invalid' }
    statedByUser = args.stated_by_user
  }

  return {
    ok: true,
    value: {
      content: content.value,
      category: category.value,
      sensitivity_hint: sensitivityHint,
      user_quote: userQuote,
      stated_by_user: statedByUser,
    },
  }
}
