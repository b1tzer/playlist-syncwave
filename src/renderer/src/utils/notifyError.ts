import { notify } from '../components/toast'
import { ipcErrorMessage } from './ipcError'

/** 技术性错误特征：状态码/网络错误/系统错误码/堆栈——识别后回退通用文案，不给用户看代码 */
const TECHNICAL_PATTERN =
  /(status\s*code|request failed|econn|enotfound|etimedout|socket|timed?\s?out|timeout|err_|enoent|eacces|\bat\s+.+\(|:\d+:\d+\)?$)/i

/**
 * 错误统一出口：右上角 toast 提示，且绝不透传代码性报错。
 * 平台给出的中文可读文案（如「酷狗：操作频繁，请稍候再试」）作为详情展示；
 * 其余（状态码、网络错误、堆栈等）回退为通用标题，不给用户看技术细节。
 */
export function notifyError(e: unknown, title: string): void {
  const raw = ipcErrorMessage(e)
  const readable = !TECHNICAL_PATTERN.test(raw) && /[\u4e00-\u9fff]/.test(raw) && raw.length <= 160
  if (readable) {
    notify('error', title, raw)
  } else {
    notify('error', title)
  }
}
