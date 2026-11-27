import { notify } from '../components/toast'
import { isUserReadableMessage, normalizeIpcError } from '@core/ipcError'

/**
 * 错误统一出口：右上角 toast 提示，且绝不透传代码性报错。
 * 平台给出的可读文案（如「酷狗：操作频繁，请稍候再试」）作为详情展示；
 * 其余（IPC 包装、状态码、网络错误、堆栈等）回退为通用标题，不给用户看技术细节。
 */
export function notifyError(e: unknown, title: string): void {
  const raw = normalizeIpcError(e)
  if (raw && isUserReadableMessage(raw)) {
    notify('error', title, raw)
  } else {
    notify('error', title)
  }
}
