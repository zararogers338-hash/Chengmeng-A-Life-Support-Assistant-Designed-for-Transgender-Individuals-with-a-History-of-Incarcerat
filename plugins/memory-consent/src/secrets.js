/**
 * 「绝不存」扫描：API Key / 令牌 / 密码、18 位身份证号、银行卡号、验证码。
 *
 * 隐私要求（提示词 §5.4）：在**提议阶段**直接拒绝，不进入待确认队列，也不让用户确认。
 * 拒绝信息绝不回显被命中的内容——返回值只包含稳定的类别名。
 *
 * 单独成文件，词表和模式都在这里，方便测试与审计。
 */

/** 命中的类别（对外只出现这些名字，不出现内容）。 */
export const SECRET_KINDS = Object.freeze({
  API_KEY: 'api_key',
  PASSWORD: 'password',
  ID_CARD: 'id_card',
  BANK_CARD: 'bank_card',
  OTP: 'otp',
})

/** 密钥/令牌类模式。 */
const KEY_PATTERNS = Object.freeze([
  // OpenAI / DeepSeek 风格的 sk- 开头的 key
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  // GitHub token
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/,
  // Authorization: Bearer ...
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // 通用 api_key / token / secret / access_key 赋值
  /(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=：]\s*\S{8,}/i,
  // 形如 sk_live_xxx / rk_live_xxx 的支付密钥
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/,
])

/** 中文/英文的密码赋值模式。 */
const PASSWORD_PATTERNS = Object.freeze([
  /(?:密码|口令|passw(?:or)?d|passwd|pwd)\s*(?:是|为|[:=：])\s*\S{3,}/i,
  /(?:密码|口令)\s*\S{3,}/,
])

/** 中国居民身份证校验位权重（GB 11643-1999）。 */
const ID_WEIGHTS = Object.freeze([7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2])
const ID_CHECK_CODES = Object.freeze(['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'])

/**
 * 验证 18 位身份证号的校验位（前 17 位数字 + 校验位）。
 * @param {string} value 18 位字符串。
 */
export function isValidChineseIdCard(value) {
  if (!/^\d{17}[\dXx]$/.test(value)) return false
  const province = Number(value.slice(0, 2))
  if (province < 11 || province > 82) return false
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(value[i]) * ID_WEIGHTS[i]
  return ID_CHECK_CODES[sum % 11] === value[17].toUpperCase()
}

/** Luhn 校验（银行卡号）。 */
export function isValidLuhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function containsChineseIdCard(text) {
  const candidates = text.match(/(?:^|[^\dA-Za-z])(\d{17}[\dXx])(?=[^\dA-Za-z]|$)/g) ?? []
  return candidates.some((chunk) => {
    const digits = chunk.match(/\d{17}[\dXx]/)?.[0] ?? ''
    return isValidChineseIdCard(digits)
  })
}

function containsBankCard(text) {
  // 允许 4 位分组（"6222 0202 0000 0000"）或连续数字；去掉分隔后做 Luhn。
  const chunks = text.match(/(?:\d[ -]?){13,25}\d/g) ?? []
  for (const chunk of chunks) {
    const digits = chunk.replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)) return true
  }
  return false
}

function containsOtp(text) {
  // 只有出现"验证码/动态码/校验码/verification code/otp"这类词时，才把邻近的 4–8 位数字当验证码，
  // 否则普通数字（年份、数量）会被误伤。
  if (!/(?:验证码|动态码|校验码|短信码|verification\s*code|\botp\b)/i.test(text)) return false
  return /(?:验证码|动态码|校验码|短信码|verification\s*code|\botp\b)[^\d]{0,12}\d{4,8}/i.test(text)
}

/**
 * 扫描内容里是否含有"绝不存"的东西。
 * @param {string} content 候选记忆的文字。
 * @returns {{ blocked: boolean, kinds: string[] }} kinds 只含稳定类别名，不含命中内容。
 */
export function scanForbiddenContent(content) {
  const text = typeof content === 'string' ? content : ''
  if (text === '') return { blocked: false, kinds: [] }
  const kinds = []
  if (KEY_PATTERNS.some((pattern) => pattern.test(text))) kinds.push(SECRET_KINDS.API_KEY)
  if (PASSWORD_PATTERNS.some((pattern) => pattern.test(text))) kinds.push(SECRET_KINDS.PASSWORD)
  if (containsChineseIdCard(text)) kinds.push(SECRET_KINDS.ID_CARD)
  if (containsBankCard(text)) kinds.push(SECRET_KINDS.BANK_CARD)
  if (containsOtp(text)) kinds.push(SECRET_KINDS.OTP)
  return { blocked: kinds.length > 0, kinds }
}
