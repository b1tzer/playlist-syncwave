import type { LogEntry } from './types'

/** 文件持久化格式：每行一条 JSON，便于检索与后续采集 */
export function formatJsonLine(entry: LogEntry): string {
  return JSON.stringify(entry)
}

/** 将 UTC 时间戳转本地可读形式（HH:mm:ss.SSS） */
function localTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

function compact(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** 终端可读格式：时间 + 级别 + 模块 + 事件 + 描述 + 上下文 + 耗时 + 错误 */
export function formatConsole(entry: LogEntry): string {
  const parts = [
    localTime(entry.timestamp),
    `[${entry.level.toUpperCase().padEnd(5)}]`,
    entry.module,
  ]
  const head = parts.join(' ')

  let line = `${head} | ${entry.event} ${entry.message}`
  if (entry.context && Object.keys(entry.context).length > 0) {
    line += ` | ${compact(entry.context)}`
  }
  if (entry.durationMs !== undefined) {
    line += ` | ${entry.durationMs}ms`
  }
  if (entry.error) {
    line += ` | error=${entry.error.name}: ${entry.error.message}`
  }
  return line
}

/** 依据环境生成默认级别：显式 LOG_LEVEL 环境变量 > 默认 */
export function defaultLevelFromEnv(): string | undefined {
  if (typeof process !== 'undefined' && process.env?.['LOG_LEVEL']) {
    return process.env['LOG_LEVEL']
  }
  return undefined
}
