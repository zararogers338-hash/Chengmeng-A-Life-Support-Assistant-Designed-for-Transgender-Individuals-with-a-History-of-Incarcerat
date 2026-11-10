import { readFileSync } from 'node:fs'

export const name = 'chengmeng-support-skills'
export const inject = ['skills', 'tools']
export const CATALOG = Object.freeze([
  { name: 'daily-life-support', title: '日常生活支持', description: '安排日程、求职材料、住房比较、生活预算与具体下一步。', whenToUse: '用户需要可执行的日常安排、清单、文案或比较时；不把闲聊强行变成计划。' },
  { name: 'social-reintegration', title: '社会资源导航', description: '按用户自己提出的需要梳理生活重建、证件、就业、住房和支持关系。', whenToUse: '用户主动提到出狱后生活或相关实际障碍时；不根据标签推断经历。' },
  { name: 'psychological-support', title: '情绪支持', description: '倾听、梳理处境、一般心理健康教育与专业支持导航。', whenToUse: '用户希望聊情绪、压力或了解心理支持时；普通事务不自动触发。' },
  { name: 'gender-health-navigation', title: '健康资源导航', description: '用户主动需要的性别与医疗信息理解、咨询准备和资源核验。', whenToUse: '用户主动提出相关身份或健康导航问题时；不能仅因用药、外貌或名字触发。' },
  { name: 'crisis-referral', title: '紧急支持导航', description: '在即时危险情境中优先现实帮助，提供有边界、可核验的支持。', whenToUse: '存在明确的当前自伤、人身危险或紧急医疗需要时；不把一般低落自动当危机。' },
])
const references = JSON.parse(readFileSync(new URL('./knowledge/references.json', import.meta.url), 'utf8'))
export function lookupReferences(ids, now = new Date()) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 || ids.some(id => typeof id !== 'string' || !references.some(r => r.id === id))) {
    return { ok: false, error: 'unknown_reference', available: references.map(r => r.id) }
  }
  return { ok: true, scope: 'generic_not_local_eligibility', references: [...new Set(ids)].map(id => {
    const item = references.find(r => r.id === id)
    return { ...item, needs_recheck: now.getTime() - Date.parse(item.verified) > 90 * 86400000 }
  }) }
}
export function apply(ctx, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) throw new Error('SUPPORT_CONFIG_INVALID')
  for (const item of CATALOG) {
    const content = readFileSync(new URL(`./skills/${item.name}/SKILL.md`, import.meta.url), 'utf8')
    if (content.length > 8192) throw new Error('SUPPORT_SKILL_TOO_LONG')
    ctx.effect(() => ctx.skills.register({ ...item, source: 'chengmeng-support-skills', content }), `support skill: ${item.name}`)
  }
  ctx.effect(() => ctx.tools.register({
    name: 'support_reference', description: '读取通用资料包的真实来源、地区范围和上次核验日期。按 Skill 给出的 ID 查询；这不是实时联网核验，不返回用户数据。',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string', enum: references.map(r => r.id) }, minItems: 1, maxItems: 6 } }, required: ['ids'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('SUPPORT_CANCELED')
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'ids')) return JSON.stringify({ ok: false, error: 'invalid' })
      return JSON.stringify(lookupReferences(args.ids))
    },
  }), 'support references')
}
