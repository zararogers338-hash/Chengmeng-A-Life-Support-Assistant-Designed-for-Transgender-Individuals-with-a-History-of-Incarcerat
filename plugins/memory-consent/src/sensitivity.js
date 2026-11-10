/**
 * 敏感度判定：中英文关键词 + 模式，纯函数，可单独测试。
 *
 * 规则（提示词 §5.2）：
 * - Agent 通过 sensitivity_hint 给出倾向，模块自己再判定一遍，**最终取两者中更敏感的那个，只升不降**。
 * - 拿不准时按敏感处理。
 * - 敏感原因只用于管理界面和内部记录；**待确认卡片上绝不显示类别名或原因字眼**。
 *
 * 词表刻意写得宽：宁可把普通条目误判成敏感（用户多点一次"记住"），
 * 也不能把敏感条目漏判成普通（可能被 auto 模式自动写入）。
 */

import { REASONS } from './model.js'

/**
 * 每个原因的中文关键词（子串匹配）与英文关键词（词边界匹配）。
 * 只做文本层面的事实判断，不推断身份：词表命中只说明"这段文字涉及这类话题"。
 */
export const SENSITIVITY_KEYWORDS = Object.freeze({
  gender_identity: Object.freeze({
    zh: ['跨性别', '变性', '性别认同', '性别身份', '性别表达', '性别焦虑', '非二元', '出生性别', '改身份证', '改名字', '过渡期', '出柜', '女装', '男装', '性别肯定', '激素治疗', '改名'],
    en: ['transgender', 'trans woman', 'trans man', 'nonbinary', 'non-binary', 'gender identity', 'gender dysphoria', 'deadname', 'transition', 'hrt', 'top surgery', 'bottom surgery'],
  }),
  sexual_orientation: Object.freeze({
    zh: ['性取向', '同性恋', '女同', '男同', '拉拉', '双性恋', '无性恋', '泛性恋', '出柜', '取向'],
    en: ['gay', 'lesbian', 'bisexual', 'asexual', 'pansexual', 'queer', 'coming out', 'orientation'],
  }),
  medical: Object.freeze({
    zh: ['用药', '吃药', '服药', '药物', '药片', '打针', '注射', '激素', '雌激素', '雄激素', '睾酮', '雌二醇', '地屈孕酮', '处方', '剂量', '就诊', '复诊', '门诊', '住院', '出院', '手术', '诊断', '病历', '化验', '检查报告', '抽血', '体检', '过敏', '慢性病', '糖尿病', '血压', '怀孕', '孕检', '流产', '病假', '医院', '医生', '精神科', '抗抑郁', '心理科'],
    en: ['medication', 'prescription', 'hormone', 'estrogen', 'testosterone', 'progesterone', 'hrt', 'dose', 'dosage', 'surgery', 'diagnosis', 'clinic', 'hospital', 'doctor', 'treatment', 'blood test', 'pregnant', 'pregnancy', 'illness'],
  }),
  mental_health: Object.freeze({
    zh: ['抑郁', '焦虑', '恐慌', '自残', '自杀', '心理咨询', '心理医生', '心理治疗', '情绪障碍', '双相', '躁郁', '创伤后', '失眠', '精神科', '吃药', '情绪低落', '心理评估'],
    en: ['depression', 'anxiety', 'panic attack', 'self-harm', 'suicide', 'therapist', 'psychotherapy', 'bipolar', 'ptsd', 'insomnia', 'mental health', 'counseling'],
  }),
  incarceration: Object.freeze({
    zh: ['服刑', '坐牢', '监狱', '看守所', '拘留', '判刑', '刑期', '案底', '缓刑', '假释', '违法', '刑事案件', '被逮捕'],
    en: ['prison', 'jail', 'incarcerated', 'sentence', 'conviction', 'parole', 'probation', 'arrested', 'criminal record', 'felony'],
  }),
  trauma: Object.freeze({
    zh: ['创伤', '虐待', '性侵', '强暴', '霸凌', '童年阴影', '意外事故', 'PTSD'],
    en: ['trauma', 'abuse', 'assault', 'rape', 'bullying', 'accident', 'ptsd'],
  }),
  domestic_violence: Object.freeze({
    zh: ['家暴', '家庭暴力', '被打', '施暴', '威胁我', '人身安全', '报警', '保护令', '逃离'],
    en: ['domestic violence', 'abusive', 'beat me', 'threatened me', 'restraining order', 'safety plan'],
  }),
  precise_location: Object.freeze({
    zh: ['住址', '家庭住址', '小区', '门牌', '单元', '楼层', '街道', '地铁站', '定位', '坐标', '邮编'],
    en: ['address', 'street', 'apartment', 'zip code', 'postcode', 'coordinates', 'location'],
  }),
  family: Object.freeze({
    zh: ['家人', '父亲', '母亲', '爸爸', '妈妈', '父母', '孩子', '女儿', '儿子', '丈夫', '妻子', '配偶', '兄弟', '姐妹', '家庭', '离婚', '抚养', '监护人', '亲戚'],
    en: ['my father', 'my mother', 'my dad', 'my mom', 'my parents', 'my son', 'my daughter', 'my child', 'my husband', 'my wife', 'my family', 'divorce', 'custody'],
  }),
  other_private: Object.freeze({
    zh: ['身份证', '工资', '收入', '欠债', '负债', '存款', '贷款', '征信', '手机号', '微信号', '邮箱', '宗教', '信仰', '政治', '诉讼', '律师', '移民', '签证'],
    en: ['salary', 'income', 'debt', 'savings', 'credit score', 'phone number', 'email address', 'religion', 'politics', 'lawsuit', 'lawyer', 'immigration', 'visa'],
  }),
})

/** 额外的结构化模式（比关键词更精确）。 */
export const SENSITIVITY_PATTERNS = Object.freeze({
  precise_location: Object.freeze([
    /\d{1,5}\s*号(?:楼|院|房|院楼)?/,
    /\d{1,3}\s*(?:栋|单元|层|室)/,
    /(?:住在|家住|搬到|地址是|住在)[^。！？\n]{2,30}/,
  ]),
  other_private: Object.freeze([
    /\b1[3-9]\d{9}\b/,
    /[\w.+-]+@[\w-]+\.[\w.-]+/,
  ]),
})

/** 英文词边界匹配用的正则缓存。 */
const englishPatternCache = new Map()

function englishPattern(word) {
  const cached = englishPatternCache.get(word)
  if (cached) return cached
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')
  englishPatternCache.set(word, pattern)
  return pattern
}

/**
 * 依次检查每个原因；返回命中的原因列表（保持 REASONS 的固定顺序）。
 * @param {string} content
 * @returns {string[]}
 */
export function matchReasons(content) {
  const text = typeof content === 'string' ? content : ''
  if (text === '') return []
  const lower = text.toLowerCase()
  const hits = []
  for (const reason of REASONS) {
    const table = SENSITIVITY_KEYWORDS[reason]
    const matched = table
      ? table.zh.some((word) => text.includes(word)) || table.en.some((word) => englishPattern(word).test(lower))
      : false
    const patternHit = (SENSITIVITY_PATTERNS[reason] ?? []).some((pattern) => pattern.test(text))
    if (matched || patternHit) hits.push(reason)
  }
  return hits
}

/**
 * 判定敏感度。
 * @param {string} content 候选文字。
 * @param {'normal'|'sensitive'|'unknown'|undefined} hint Agent 给的 sensitivity_hint。
 * @returns {{ sensitivity: 'normal'|'sensitive', reasons: string[] }}
 */
export function detectSensitivity(content, hint) {
  const reasons = matchReasons(content)
  const hintSaysSensitive = hint === 'sensitive'
  if (reasons.length === 0 && !hintSaysSensitive) return { sensitivity: 'normal', reasons: [] }
  // Agent 说是敏感、但词表没命中：记成 other_private（只升不降，且拿不准按敏感处理）。
  return { sensitivity: 'sensitive', reasons: reasons.length > 0 ? reasons : ['other_private'] }
}

/**
 * 把原因列表转成中文名（管理界面用）。
 * @param {string[]} reasons
 * @param {Record<string, string>} labels
 */
export function describeReasons(reasons, labels) {
  const output = []
  for (const reason of reasons) {
    const label = labels?.[reason]
    if (label && !output.includes(label)) output.push(label)
  }
  return output
}
