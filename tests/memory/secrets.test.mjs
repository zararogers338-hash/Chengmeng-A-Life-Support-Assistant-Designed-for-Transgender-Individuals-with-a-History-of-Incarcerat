/**
 * 「绝不存」扫描单测：API Key / 令牌 / 密码 / 身份证号 / 银行卡号 / 验证码。
 * 返回值只含类别名，绝不回显命中内容；普通数字与年份不误伤。
 * 全部使用虚构的测试号。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SECRET_KINDS,
  isValidChineseIdCard,
  isValidLuhn,
  scanForbiddenContent,
} from '../../plugins/memory-consent/src/secrets.js'

/** 断言被拦截，并且返回结果里只有类别名、没有原文片段。 */
function assertBlocked(content, kind, fragments = []) {
  const result = scanForbiddenContent(content)
  assert.equal(result.blocked, true, `「${content}」应当被拒绝`)
  assert.ok(result.kinds.includes(kind), `「${content}」应命中 ${kind}，实际 ${result.kinds.join(',')}`)
  const serialized = JSON.stringify(result)
  for (const fragment of fragments) {
    assert.ok(!serialized.includes(fragment), `返回结构里不能回显原文片段：${fragment}`)
  }
  return result
}

test('sk- 开头的 API Key 被拒绝', () => {
  assertBlocked('我的密钥是 sk-abcdefghijklmnopqrstuvwxyz012345，别弄丢了', SECRET_KINDS.API_KEY, [
    'sk-abcdefghijklmnopqrstuvwxyz012345',
  ])
  assertBlocked('sk-proj-1234567890abcdefghijklmnop', SECRET_KINDS.API_KEY)
})

test('Bearer 令牌被拒绝', () => {
  assertBlocked('请求头是 Bearer abcdefghijklmnop123456', SECRET_KINDS.API_KEY, ['abcdefghijklmnop123456'])
})

test('GitHub / AWS 风格令牌被拒绝', () => {
  assertBlocked('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', SECRET_KINDS.API_KEY)
  assertBlocked('AKIAABCDEFGHIJKLMNOP 是访问密钥', SECRET_KINDS.API_KEY)
})

test('password: 与中文密码写法被拒绝', () => {
  assertBlocked('password: hunter2secret', SECRET_KINDS.PASSWORD, ['hunter2secret'])
  assertBlocked('密码是 abcdefg', SECRET_KINDS.PASSWORD, ['abcdefg'])
  assertBlocked('口令：qwerty123', SECRET_KINDS.PASSWORD, ['qwerty123'])
})

test('18 位身份证号（合法校验位）被拒绝', () => {
  // 虚构测试号：11010519491231002X 是常用示例，校验位合法。
  assert.equal(isValidChineseIdCard('11010519491231002X'), true)
  assert.equal(isValidChineseIdCard('110105194912310021'), false, '错误校验位不应通过校验')
  assertBlocked('身份证号 11010519491231002X 帮我记一下', SECRET_KINDS.ID_CARD, ['11010519491231002X'])
})

test('银行卡号（Luhn 合法的虚构号）被拒绝，允许分组写法', () => {
  assert.equal(isValidLuhn('4111111111111111'), true)
  assert.equal(isValidLuhn('4111111111111112'), false)
  assertBlocked('卡号 4111111111111111', SECRET_KINDS.BANK_CARD, ['4111111111111111'])
  assertBlocked('卡号 4111 1111 1111 1111 别存', SECRET_KINDS.BANK_CARD)
})

test('验证码被拒绝（只在出现验证码类关键词时判定）', () => {
  assertBlocked('验证码是 483920，十分钟内有效', SECRET_KINDS.OTP, ['483920'])
  assertBlocked('verification code: 987654', SECRET_KINDS.OTP)
})

test('普通数字、年份、数量不误伤', () => {
  const benign = [
    '2026 年 11 月 10 日要去复查',
    '这个月花了 320 元',
    '订单号 1234567890123456', // 16 位但不满足 Luhn
    '手机号 13800138000', // 不是密钥/卡号（敏感度另算）
    '房间号 1203，楼层 12',
    '2026 年的目标是读完 12 本书',
  ]
  for (const content of benign) {
    const result = scanForbiddenContent(content)
    assert.equal(result.blocked, false, `「${content}」不应被当作密钥拒绝：${result.kinds.join(',')}`)
    assert.deepEqual(result.kinds, [])
  }
})

test('身份证号只认校验位合法的：格式像但校验位错的数字不按身份证拒绝', () => {
  const result = scanForbiddenContent('编号 110105194912310021 只是普通编号')
  assert.equal(result.kinds.includes(SECRET_KINDS.ID_CARD), false)
})

test('空内容与非法输入不崩溃', () => {
  assert.deepEqual(scanForbiddenContent(''), { blocked: false, kinds: [] })
  assert.deepEqual(scanForbiddenContent(undefined), { blocked: false, kinds: [] })
  assert.deepEqual(scanForbiddenContent(42), { blocked: false, kinds: [] })
})

test('多个类别同时命中时全部列出', () => {
  const result = scanForbiddenContent('sk-abcdefghijklmnopqrstuvwxyz012345 和卡号 4111111111111111')
  assert.equal(result.blocked, true)
  assert.ok(result.kinds.includes(SECRET_KINDS.API_KEY))
  assert.ok(result.kinds.includes(SECRET_KINDS.BANK_CARD))
})
