import { app } from 'electron'
import { join } from 'node:path'
import {
  ConsoleTransport,
  createLogger,
  isLogLevel,
  sanitizeContext,
  setDefaultTransports,
  setLogLocale,
} from '@core/logging'
import type { LogEntry, LogLevel, Logger, LogProcess, LogTransport } from '@core/logging'
import { FileLogTransport } from './fileTransport'
import { getDatabase } from '../appDatabase'

const RENDERER_MAX_BYTES = 32 * 1024
const STRING_MAX_LENGTH = 400

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= STRING_MAX_LENGTH
}

function isValidContext(value: unknown): value is Record<string, unknown> | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  try {
    return JSON.stringify(value).length <= RENDERER_MAX_BYTES
  } catch {
    return false
  }
}

function isValidError(value: unknown): boolean {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  const { name, message, stack } = value
  return (
    typeof name === 'string' &&
    name.length <= 100 &&
    typeof message === 'string' &&
    message.length <= STRING_MAX_LENGTH &&
    (stack === undefined || (typeof stack === 'string' && stack.length <= 4000))
  )
}

/**
 * 渲染进程经 IPC 投递的日志结构校验。
 * 仅接受字段类型合规的条目，防止异常/恶意数据污染日志文件。
 */
function sanitizeRendererEntry(raw: unknown): LogEntry | null {
  if (!isPlainObject(raw)) return null
  const { timestamp, level, module, event, message, context, durationMs, error } = raw

  if (!isBoundedString(timestamp) || Number.isNaN(Date.parse(timestamp))) return null
  if (!isLogLevel(level)) return null
  if (!isBoundedString(module) || !isBoundedString(event) || !isBoundedString(message)) return null
  if (!isValidContext(context)) return null
  if (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs))) {
    return null
  }
  if (!isValidError(error)) return null

  const entry: LogEntry = {
    timestamp,
    level: level as LogLevel,
    module,
    event,
    message,
    process: 'renderer',
  }
  if (context) entry.context = context
  if (durationMs !== undefined) entry.durationMs = durationMs
  if (error) entry.error = error as LogEntry['error']
  return entry
}

/**
 * 主进程日志中心：统一持有各传输，并向 core 注册为全局默认传输，
 * 使平台适配器 / 同步引擎等所有模块的日志自动落盘。
 */
class LogCenter {
  private transports: LogTransport[] = []
  private initialized = false

  init(): void {
    if (this.initialized) return
    const logDir = join(app.getPath('userData'), 'logs')
    // app 文件排除 error（error 独立成文件），error 文件只写 error
    const appFile = new FileLogTransport(logDir, { levels: ['debug', 'info', 'warn'] })
    const errorFile = new FileLogTransport(logDir, { prefix: 'error', levels: ['error'] })
    appFile.init()
    errorFile.init()
    this.transports = [new ConsoleTransport(), appFile, errorFile]
    setDefaultTransports(this.transports)
    // 日志消息语言跟随应用设置（数据库未就绪时回退默认中文）
    try {
      const language = getDatabase().settings.get('language', 'zh-CN')
      setLogLocale(String(language))
    } catch {
      // 保持默认 locale
    }
    this.initialized = true
  }

  logger(module: string, options?: { level?: LogLevel; process?: LogProcess }): Logger {
    return createLogger({
      module,
      process: options?.process ?? 'main',
      level: options?.level,
      baseContext: {
        platform: process.platform,
        appVersion: app.getVersion(),
      },
    })
  }

  /** 接收渲染进程日志（IPC 校验 + 主进程侧二次脱敏，防伪造敏感数据落盘） */
  writeRendererEntry(raw: unknown): void {
    const entry = sanitizeRendererEntry(raw)
    if (!entry) return
    if (entry.context && Object.keys(entry.context).length > 0) {
      entry.context = sanitizeContext(entry.context)
    }
    for (const transport of this.transports) {
      try {
        transport.write(entry)
      } catch {
        // 忽略单传输失败
      }
    }
  }

  /** 应用退出前同步落盘 */
  flush(): void {
    for (const transport of this.transports) {
      try {
        void transport.flush?.()
      } catch {
        // 忽略
      }
    }
  }
}

export const logCenter = new LogCenter()
