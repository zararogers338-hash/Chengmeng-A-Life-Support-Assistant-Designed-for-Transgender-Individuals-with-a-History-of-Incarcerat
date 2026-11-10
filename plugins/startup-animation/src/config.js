/**
 * 启动动画的配置读取。纯函数，不依赖 DSH。
 *
 * 显示名称按项目要求走统一配置项 AGENT_DISPLAY_NAME，默认 Chengmeng，不在别处硬编码。
 * 已知缺口：统一配置文件（config/agent.yaml）还不存在，所以这里读取一个约定的全局钩子
 * `globalThis.__CHENGMENG_CONFIG__.agentDisplayName`；以后由统一配置注入它即可，调用方不用改。
 *
 * 构建脚本会把本文件内联进 lib/client.js，所以这里只能使用顶层的 `export const` 或 `export function`。
 */

export const DEFAULT_AGENT_NAME = 'Chengmeng'
export const STARTUP_KEY = 'chengmeng.appearance.startup'
export const DIAG_KEY = 'chengmeng.startup.diag'

/** 显示名称：非空字符串、不超过 24 个字符，否则回退到默认值。 */
export function agentDisplayName(root = globalThis) {
  const value = root?.__CHENGMENG_CONFIG__?.agentDisplayName
  if (typeof value !== 'string') return DEFAULT_AGENT_NAME
  const name = value.trim()
  return name.length > 0 && name.length <= 24 ? name : DEFAULT_AGENT_NAME
}

/** 读 localStorage 永远不抛：隐私模式、禁用站点数据时返回 null。 */
export function readSetting(storage, key) {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function startupDisabled(storage) {
  return readSetting(storage, STARTUP_KEY) === 'off'
}

/** Only add a readiness row when the memory client's package is installed. */
export function hasMemoryModule(boot) {
  return Array.isArray(boot?.entries) && boot.entries.some(entry => entry?.id === '@chengmeng/dsh-memory-consent')
}

export function memoryStatusReady(value) {
  // A disabled memory feature is still a healthy module. Never enable it here.
  return value?.ok === true && typeof value.enabled === 'boolean'
}
