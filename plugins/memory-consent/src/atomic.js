/**
 * 原子写：写临时文件 → 同目录 rename。
 *
 * 为什么不能直接 writeFile：断电或崩溃会在目标位置留下半截文件，而记忆文件是唯一事实来源。
 * 同目录 rename 在 POSIX 上是原子的；Windows 上 rename 可能因为杀毒软件/索引器短暂占用而失败，
 * 所以对 EPERM/EACCES/EBUSY 做有限重试，仍然失败就抛出——调用方负责报告失败，绝不留下半截文件。
 *
 * 本文件只依赖 node:fs/promises，不 import DSH。
 */

import { promises as fsp } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Windows 上 rename 常见的可重试错误码。 */
export const RENAME_RETRY_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY'])

/** 重试之间的间隔（毫秒）；第 n 次失败后等 RETRY_DELAYS_MS[n]。 */
export const RETRY_DELAYS_MS = Object.freeze([10, 25, 60, 120])

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 原子写文件。
 * @param {string} file 目标绝对路径。
 * @param {string|Uint8Array} data 要写入的内容。
 * @param {{ fs?: object, retryDelays?: readonly number[], mode?: number }} [options]
 *   fs 可以注入替身，用来在测试里模拟 rename 失败。
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(file, data, options = {}) {
  const fs = options.fs ?? fsp
  const delays = options.retryDelays ?? RETRY_DELAYS_MS
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  await fs.mkdir(dirname(file), { recursive: true })
  try {
    await fs.writeFile(temp, data, options.mode === undefined ? undefined : { mode: options.mode })
  } catch (error) {
    // 临时文件都没写成功时，目标文件保持原样；尽力清掉临时文件，失败也不掩盖原始错误。
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  let lastError
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fs.rename(temp, file)
      return
    } catch (error) {
      lastError = error
      if (!RENAME_RETRY_CODES.includes(error?.code) || attempt === delays.length) break
      await wait(delays[attempt])
    }
  }
  await fs.rm(temp, { force: true }).catch(() => {})
  throw lastError
}

/**
 * 删除文件；文件不存在时视为成功。
 * @param {string} file 绝对路径。
 * @param {{ fs?: object }} [options]
 */
export async function removeFile(file, options = {}) {
  const fs = options.fs ?? fsp
  try {
    await fs.rm(file, { force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
