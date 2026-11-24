/**
 * 渲染层 IPC 错误处理工具。
 *
 * Electron 的 ipcRenderer.invoke 被主进程 reject 时，错误信息会被包装成：
 *   "Error invoking remote method 'platform:xxx': Error: 实际消息"
 * 直接展示给用户会暴露内部通道名与技术细节，这里剥离包装还原真实消息。
 */
export function ipcErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const match = raw.match(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/)
  return (match ? match[1] : raw).trim() || raw
}
