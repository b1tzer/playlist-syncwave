/**
 * 渲染层 IPC 错误处理工具。
 *
 * Electron 的 ipcRenderer.invoke 被主进程 reject 时，错误信息会被包装成：
 *   "Error invoking remote method 'platform:xxx': Error: 实际消息"
 * preload 层已做第一轮剥离，这里再做第二轮（兼容直接注入/旧路径），
 * 并提供「展示给用户」的统一出口 userFacingErrorMessage：
 * 技术性报错（状态码、网络错误、堆栈等）一律回退为通用文案。
 */
import { isUserReadableMessage, normalizeIpcError } from '@core/ipcError'

/** 剥离 Electron invoke 包装还原真实消息（空消息回退原始字符串，保持旧语义） */
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return normalizeIpcError(raw) || raw
}

/**
 * 用户可读错误文案的统一出口：
 * 剥离 IPC 包装后，仅当消息可读（非技术特征、长度合理）时原样返回，
 * 否则回退为调用方提供的通用文案——所有展示路径（toast、任务失败原因、同步历史）共用。
 */
export function userFacingErrorMessage(e: unknown, fallback: string): string {
  const msg = normalizeIpcError(e)
  if (msg && isUserReadableMessage(msg)) return msg
  return fallback
}
