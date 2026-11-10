/**
 * 存储加密接口（预留）。
 *
 * 规范（docs/DEV_STANDARDS.md §9.7）要求：不自己发明加密算法，但为以后的系统密钥设施预留一个
 * `StorageCipher` 接口，现在用恒等实现（明文落盘，依赖 BitLocker / 目录权限）。
 *
 * 以后接系统密钥设施时只需要：
 *   1. 实现 `encrypt(plainBytes) -> cipherBytes` 与 `decrypt(cipherBytes) -> plainBytes`（都是异步）；
 *   2. 在 index.js 里把它传给 createStore({ cipher })；
 * 存储层、Markdown 解析、索引、路由都不需要改。
 *
 * 恒等实现仍然是**必需**的：这样"数据是否加密"就是一个显式的、可以审计的选择，
 * 而不是散落在各处的 writeFile。
 */

/** 当前实现的稳定标识；写进文档与日志（不写内容）。 */
export const CIPHER_IDENTITY = 'identity'

/**
 * 恒等加密：字节原样返回。不是加密，只是接口占位。
 * @returns {{ id: string, encrypt: (bytes: Uint8Array|Buffer) => Promise<Uint8Array|Buffer>, decrypt: (bytes: Uint8Array|Buffer) => Promise<Uint8Array|Buffer> }}
 */
export function createIdentityCipher() {
  return {
    id: CIPHER_IDENTITY,
    async encrypt(bytes) {
      return bytes
    },
    async decrypt(bytes) {
      return bytes
    },
  }
}

/**
 * 创建存储层要用的 cipher。目前总是恒等实现；将来可以按配置返回系统密钥实现。
 * @param {{ cipher?: object }|null} [options]
 */
export function resolveStorageCipher(options) {
  const cipher = options?.cipher
  if (cipher === undefined || cipher === null) return createIdentityCipher()
  if (typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw new TypeError('StorageCipher 必须提供 encrypt / decrypt')
  }
  return cipher
}
