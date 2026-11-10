/**
 * Markdown 块格式单测：序列化 / 解析往返无损、坏块隔离、派生视图。
 * 全部使用虚构数据；不碰真实数据目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VIEW_NAMES,
  contentFence,
  longestBacktickRun,
  parseDocument,
  renderViews,
  serializeBlock,
  serializeDocument,
} from '../../plugins/memory-consent/src/markdown.js'
import { buildRecord, validateMemoryRecord } from '../../plugins/memory-consent/src/model.js'

const FIXED_CLOCK = () => new Date('2026-11-10T03:12:00.000Z')
const MAX = 4000

/** 构造一条合法记忆记录（先 build 再校验，保证测的是真实可落盘的记录）。 */
function makeRecord(overrides = {}) {
  const built = buildRecord({
    content: '默认内容',
    category: 'preference',
    sensitivity: 'normal',
    reasons: [],
    source: 'session:test-session#turn:3',
    quote_verified: 'unknown',
    confirmed_by_user: true,
    clock: FIXED_CLOCK,
    ...overrides,
  })
  const checked = validateMemoryRecord(built, { maxContentChars: MAX })
  assert.equal(checked.ok, true, `构造的记录应当合法：${checked.ok ? '' : checked.error}`)
  return checked.value
}

/** 往返一次：序列化 → 解析 → 断言无损。 */
function assertRoundTrip(content) {
  const record = makeRecord({ content })
  const document = serializeDocument([record])
  const parsed = parseDocument(document, { maxContentChars: MAX })
  assert.equal(parsed.quarantined.length, 0, `内容不应产生坏块：${JSON.stringify(content)}`)
  assert.equal(parsed.records.length, 1)
  assert.deepEqual(parsed.records[0], record)
  // 二次往返也要稳定。
  const again = parseDocument(serializeDocument(parsed.records), { maxContentChars: MAX })
  assert.deepEqual(again.records[0], record)
}

test('Markdown 往返无损：CJK、emoji、空行、超长行、特殊符号', () => {
  const cases = [
    '用户希望日常交流中不主动讨论性别身份。',
    '今天心情不错 😊🎉，记得买牛奶',
    '第一行\n\n第三行（中间是空行）',
    '超长行：' + 'x'.repeat(1000),
    '符号：| 竖线 | *星号* | _下划线_ | ~~删除线~~ | `反引号`',
    '制表符\t与全角空格\u3000混排',
  ]
  for (const content of cases) assertRoundTrip(content)
})

test('Markdown 往返无损：内容里出现 `## mem_...` 块头', () => {
  assertRoundTrip(
    '内容里出现块头：\n\n## mem_3f2a9c1e-1111-4222-8333-444455556666\n\n这一行只是内容，不是新块。',
  )
  // 内容的第一行就是块头也必须安全。
  assertRoundTrip('## mem_3f2a9c1e-1111-4222-8333-444455556666\n第二行')
})

test('Markdown 往返无损：`---`、`<!-- -->` 与元数据相似文字', () => {
  assertRoundTrip('分隔线：\n---\n以及 *** 和 ___')
  assertRoundTrip('注释：<!-- 这是内容里的注释，不是块边界 -->')
  assertRoundTrip(
    '- category: preference\n- sensitivity: sensitive\n- created_at: 2026-01-01T00:00:00.000Z\n- quote_verified: unknown',
  )
})

test('Markdown 往返无损：代码围栏（``` 与 ````）和大量反引号', () => {
  assertRoundTrip('代码围栏：\n```js\nconst a = 1\n```\n结束')
  assertRoundTrip('四重围栏：\n````\ninner ``` fence\n````\n结束')
  assertRoundTrip('反引号测试 ```` ``` `` ` end')
  assertRoundTrip('全是反引号的一行：\n`````')
})

test('Markdown 往返无损：多行内容与文件以换行结尾', () => {
  const record = makeRecord({ content: '第一行\n第二行\n第三行' })
  const document = serializeDocument([record])
  assert.ok(document.endsWith('\n'), '序列化后的文件应当以换行结尾')
  const parsed = parseDocument(document, { maxContentChars: MAX })
  assert.deepEqual(parsed.records[0], record)

  // 内容本身以换行结尾时，规范化会去掉尾部空白，之后再往返仍无损。
  const trailing = makeRecord({ content: '以换行结尾的内容\n' })
  assert.equal(trailing.content, '以换行结尾的内容')
  assertRoundTrip(trailing.content)
})

test('围栏长度随内容里最长反引号动态变长', () => {
  assert.equal(longestBacktickRun('没有反引号'), 0)
  assert.equal(longestBacktickRun('a```b'), 3)
  assert.equal(longestBacktickRun('`` ```` ``'), 4)
  assert.equal(contentFence('没有反引号'), '```')
  assert.equal(contentFence('a```b'), '````')
  assert.equal(contentFence('a````b'), '`````')
})

test('多个块一起往返：顺序与内容都保持', () => {
  const records = [
    makeRecord({ content: '第一条 `代码`\n\n## mem_aaa' }),
    makeRecord({ content: '第二条 --- 分隔线', category: 'goal' }),
    makeRecord({ content: '第三条 😀', category: 'episode', sensitivity: 'sensitive', reasons: ['medical'] }),
  ]
  const document = serializeDocument(records)
  const parsed = parseDocument(document, { maxContentChars: MAX })
  assert.deepEqual(parsed.records, records)
})

test('坏块被隔离，好的块照常返回，解析不崩溃', () => {
  const good1 = makeRecord({ content: '好块一' })
  const good2 = makeRecord({ content: '好块二' })
  const corrupt = [
    '## mem_11111111-2222-4333-8444-555555555555',
    '',
    '这段缺少内容围栏',
    '',
    '- category: preference',
  ].join('\n')
  const text = `${serializeBlock(good1)}\n\n${corrupt}\n\n${serializeBlock(good2)}\n`

  const parsed = parseDocument(text, { maxContentChars: MAX })
  assert.equal(parsed.records.length, 2)
  assert.deepEqual(parsed.records.map((item) => item.id), [good1.id, good2.id])
  assert.equal(parsed.quarantined.length, 1)
  assert.match(parsed.quarantined[0].reason, /围栏/)
  assert.match(parsed.quarantined[0].raw, /这段缺少内容围栏/)
})

test('元数据不合法的块被隔离，不污染其它块', () => {
  const good = makeRecord({ content: '正常块' })
  const badCategory = [
    '## mem_22222222-3333-4444-8555-666666666666',
    '',
    '```',
    '坏元数据块',
    '```',
    '',
    '- category: 不存在的类别',
    '- sensitivity: normal',
    '- reasons: ',
    '- created_at: 2026-11-10T03:12:00.000Z',
    '- updated_at: 2026-11-10T03:12:00.000Z',
    '- confirmed_by_user: true',
    '- edited_by_user: false',
    '- source: session:unknown',
    '- quote_verified: unknown',
  ].join('\n')
  const parsed = parseDocument(`${serializeBlock(good)}\n\n${badCategory}\n`, { maxContentChars: MAX })
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.records[0].id, good.id)
  assert.equal(parsed.quarantined.length, 1)
  assert.match(parsed.quarantined[0].reason, /category/)
})

test('重复 id 被隔离，只保留第一块', () => {
  const first = makeRecord({ content: '第一条同 id 内容' })
  const duplicate = { ...first, content: '第二条同 id 内容' }
  const text = `${serializeBlock(first)}\n\n${serializeBlock(duplicate)}\n`
  const parsed = parseDocument(text, { maxContentChars: MAX })
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.records[0].content, '第一条同 id 内容')
  assert.equal(parsed.quarantined.length, 1)
  assert.match(parsed.quarantined[0].reason, /重复的 id/)
})

test('块头之前的杂项内容被隔离；没有块的文本整体隔离', () => {
  const good = makeRecord({ content: '正常内容' })
  const withPreamble = parseDocument(`手工写的杂项\n\n${serializeBlock(good)}\n`, { maxContentChars: MAX })
  assert.equal(withPreamble.records.length, 1)
  assert.equal(withPreamble.quarantined.length, 1)
  assert.match(withPreamble.quarantined[0].reason, /块头之前/)

  const garbage = parseDocument('完全不是记忆文件的一段话', { maxContentChars: MAX })
  assert.deepEqual(garbage.records, [])
  assert.equal(garbage.quarantined.length, 1)
  assert.match(garbage.quarantined[0].reason, /没有可识别的记忆块/)

  assert.deepEqual(parseDocument('', { maxContentChars: MAX }), { records: [], quarantined: [] })
})

test('派生视图内容正确：按类别分组，不包含被隔离的块', () => {
  const preference = makeRecord({ content: '喜欢喝乌龙茶', category: 'preference' })
  const goal = makeRecord({ content: '下个月完成项目', category: 'goal' })
  const sensitive = makeRecord({
    content: '最近在服药',
    category: 'preference',
    sensitivity: 'sensitive',
    reasons: ['medical'],
  })

  const goodBlock = serializeDocument([preference, goal, sensitive])
  const corrupt = '## mem_33333333-4444-4555-8666-777777777777\n\n被隔离的文字XYZ\n'
  const parsed = parseDocument(`${goodBlock}\n${corrupt}`, { maxContentChars: MAX })
  assert.equal(parsed.quarantined.length, 1)

  const views = renderViews(parsed.records)
  assert.deepEqual(Object.keys(views), [...VIEW_NAMES])
  assert.match(views['profile.md'], /喜欢喝乌龙茶/)
  assert.match(views['profile.md'], /下个月完成项目/)
  assert.match(views['profile.md'], /最近在服药/)
  assert.match(views['preferences.md'], /喜欢喝乌龙茶/)
  assert.doesNotMatch(views['preferences.md'], /下个月完成项目/)
  assert.match(views['goals.md'], /下个月完成项目/)
  assert.doesNotMatch(views['goals.md'], /喜欢喝乌龙茶/)
  assert.match(views['episodes.md'], /还没有记录/)
  for (const view of Object.values(views)) assert.doesNotMatch(view, /被隔离的文字XYZ/)
})

test('派生视图按创建时间排序，并转义反引号与换行', () => {
  const later = makeRecord({ content: '后面的记录', clock: () => new Date('2026-11-11T00:00:00.000Z') })
  const earlier = makeRecord({ content: '前面的记录', clock: () => new Date('2026-11-09T00:00:00.000Z') })
  const views = renderViews([later, earlier])
  const profile = views['profile.md']
  assert.ok(profile.indexOf('前面的记录') < profile.indexOf('后面的记录'))

  const withBacktick = makeRecord({ content: '包含 `反引号`\n和换行' })
  const escaped = renderViews([withBacktick])['profile.md']
  assert.match(escaped, /\\`反引号\\`/)
  assert.ok(!escaped.includes('包含 `反引号`\n'), '视图里不保留原始换行')
})
