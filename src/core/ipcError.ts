/**
 * IPC 错误信息规范化（preload 与渲染层共用，禁止依赖 Node/Electron 专属 API）。
 *
 * Electron 的 ipcRenderer.invoke 被主进程 reject 时，错误信息会被包装成：
 *   "Error invoking remote method 'platform:xxx': Error: 实际消息"
 * 直接展示会暴露内部通道名与技术细节。这里剥离包装前缀还原业务消息；
 * 展示层再经 isUserReadableMessage 过滤技术性报错，回退为通用文案。
 */

/**
 * 剥离 "Error invoking remote method '<channel>': " 与多重 "Error: " 前缀，还原业务消息。
 * 对任意输入（Error / 字符串 / 其他值）都安全返回字符串。
 */
export function normalizeIpcError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/g, '')
    .replace(/^(?:Error:\s*)+/, '')
    .trim()
}

/**
 * 技术性错误特征：状态码 / 网络错误 / 系统错误码 / JS 运行时错误 / 堆栈痕迹——
 * 命中即判定为「代码性报错」，回退通用文案，不给用户看内部细节。
 */
const TECHNICAL_PATTERN =
  /(error invoking remote method|status\s*code|request failed|econn|enotfound|etimedout|socket|timed?\s?out|timeout|err_|enoent|eacces|\bundefined\b|\bnull\b|unexpected\s+token|is not a function|cannot read propert|\bat\s+.+\(|:\d+:\d+\)?$)/i

/**
 * 是否适合直接展示给用户：
 * - 不含技术特征（状态码、网络/系统错误、堆栈等）；
 * - 至少含一个字母或数字（排除纯符号/空串）；
 * - 长度合理（超长文案多为序列化对象/堆栈）。
 */
export function isUserReadableMessage(message: string): boolean {
  return (
    !TECHNICAL_PATTERN.test(message) &&
    /[\p{L}\p{N}]/u.test(message) &&
    message.length <= 160
  )
}
