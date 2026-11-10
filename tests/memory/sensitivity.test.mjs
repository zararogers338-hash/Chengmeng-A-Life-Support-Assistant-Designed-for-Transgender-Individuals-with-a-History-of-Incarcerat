/**
 * 敏感度判定单测：中英文关键词、examples、hint 只升不降、normal 时 reasons 为空。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SENSITIVITY_KEYWORDS,
  describeReasons,
  detectSensitivity,
  matchReasons,
} from '../../plugins/memory-consent/src/sensitivity.js'
import { REASONS, REASON_LABELS } from '../../plugins/memory-consent/src/model.js'

test('中文关键词命中：身份、医疗、心理、司法、家庭等类别', () => {
  const cases = [
    ['她是一名跨性别女性', 'gender_identity'],
    ['用户希望不要主动提起出柜这件事', 'gender_identity'],
    ['最近在服用激素，情绪有点波动', 'medical'],
    ['下周三要去医院复诊', 'medical'],
    ['最近抑郁得厉害，整晚失眠', 'mental_health'],
    ['有过服刑经历，不想再提', 'incarceration'],
    ['小时候被霸凌过，算童年阴影', 'trauma'],
    ['家里发生过家暴，已经报警', 'domestic_violence'],
    ['不想透露家庭住址和小区', 'precise_location'],
    ['我妈妈最近身体不好', 'family'],
    ['工资卡和征信都出了点问题', 'other_private'],
  ]
  for (const [content, reason] of cases) {
    assert.ok(matchReasons(content).includes(reason), `「${content}」应命中 ${reason}`)
  }
})

test('英文关键词命中（按词边界，避免误伤普通单词）', () => {
  assert.ok(matchReasons('I am a transgender woman').includes('gender_identity'))
  assert.ok(matchReasons('my doctor changed my medication').includes('medical'))
  assert.ok(matchReasons('I struggle with depression').includes('mental_health'))
  assert.ok(matchReasons('my father lives far away').includes('family'))
  assert.ok(matchReasons('the restaurant is nice').length === 0)
  // 包含但不在词边界上的单词不算命中（如 "transgender" 之外的 "gender" 子串）。
  assert.ok(!matchReasons('the gender of the noun').includes('gender_identity'))
})

test('gender_identity / medical 的 examples 判定为敏感', () => {
  const gender = detectSensitivity('她是一名跨性别女性，正在经历性别焦虑', 'normal')
  assert.equal(gender.sensitivity, 'sensitive')
  assert.ok(gender.reasons.includes('gender_identity'))

  const medical = detectSensitivity('用户正在服用激素', 'normal')
  assert.equal(medical.sensitivity, 'sensitive')
  assert.ok(medical.reasons.includes('medical'))
})

// 提示词 §4.3 的规范性示例原文是「用户希望日常交流中不主动讨论性别身份。」。
// 词表已补上「性别身份/性别表达」等常见说法。
test('提示词 §4.3 的示例原句应当判为敏感', () => {
  const result = detectSensitivity('用户希望日常交流中不主动讨论性别身份。', 'normal')
  assert.equal(result.sensitivity, 'sensitive')
  assert.ok(result.reasons.includes('gender_identity'))
})

test('sensitivity_hint=sensitive 时升级为敏感，即使词表没命中', () => {
  const result = detectSensitivity('明天想去公园散步', 'sensitive')
  assert.equal(result.sensitivity, 'sensitive')
  assert.deepEqual(result.reasons, ['other_private'], 'Agent 说敏感但词表没命中时记 other_private')
})

test('hint=normal 但词表命中时仍然判为 sensitive（只升不降）', () => {
  const result = detectSensitivity('我妻子下周做手术', 'normal')
  assert.equal(result.sensitivity, 'sensitive')
  assert.ok(result.reasons.includes('medical'))
  assert.ok(result.reasons.includes('family'))
})

test('normal 时 reasons 为空', () => {
  for (const content of ['明天上午十点开会', '喜欢喝无糖乌龙茶', '想学一点摄影']) {
    const result = detectSensitivity(content, 'normal')
    assert.deepEqual(result, { sensitivity: 'normal', reasons: [] })
  }
  // 缺省 hint 也按 normal 处理。
  assert.deepEqual(detectSensitivity('周末去爬山', undefined), { sensitivity: 'normal', reasons: [] })
})

test('拿不准时按敏感处理：hint 未知、空内容', () => {
  assert.equal(detectSensitivity('随便一句话', 'unknown').sensitivity, 'normal')
  assert.equal(detectSensitivity('', 'sensitive').sensitivity, 'sensitive')
  assert.deepEqual(detectSensitivity('', 'normal'), { sensitivity: 'normal', reasons: [] })
})

test('reasons 去重并保持固定顺序', () => {
  const reasons = matchReasons('跨性别，最近在服药，还要去医院复诊')
  assert.equal(new Set(reasons).size, reasons.length)
  const order = reasons.map((reason) => REASONS.indexOf(reason))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
})

test('词表覆盖提示词 §5.1 的全部敏感类别', () => {
  for (const reason of REASONS) {
    assert.ok(SENSITIVITY_KEYWORDS[reason], `${reason} 应当有词表`)
    assert.ok(SENSITIVITY_KEYWORDS[reason].zh.length > 0, `${reason} 应当有中文关键词`)
    assert.ok(SENSITIVITY_KEYWORDS[reason].en.length > 0, `${reason} 应当有英文关键词`)
  }
  // 每个类别至少有一个中文词能真正触发判定。
  for (const reason of REASONS) {
    const word = SENSITIVITY_KEYWORDS[reason].zh[0]
    assert.ok(matchReasons(`这是一句包含${word}的虚构句子`).includes(reason), `${reason} 的首个中文词应命中`)
  }
})

test('结构化模式：具体地址、手机号、邮箱判为敏感', () => {
  assert.ok(matchReasons('住在幸福小区3号楼').includes('precise_location'))
  assert.ok(matchReasons('我的手机号是13800138000').includes('other_private'))
  assert.ok(matchReasons('邮箱是 someone@example.com').includes('other_private'))
})

test('describeReasons 输出中文名且去重', () => {
  const labels = describeReasons(['medical', 'family', 'medical', 'unknown_reason'], REASON_LABELS)
  assert.deepEqual(labels, ['医疗健康', '家庭关系'])
  assert.deepEqual(describeReasons(['medical'], undefined), [])
})
