import { defaultLevelFromEnv } from './format'
import { LOG_LEVELS, meetsLevel, parseLogLevel } from './levels'
import { LOG_MESSAGE_EN } from './messages'
import { sanitizeContext } from './redact'
import { ConsoleTransport, isTestEnv } from './transports'
import type {
  LogContext,
  LogEntry,
  LogErrorInfo,
  Logger,
  LoggerOptions,
  LogLevel,
  LogProcess,
  LogTransport,
} from './types'

/**
 * 全局默认传输：主进程初始化时通过 setDefaultTransports 注入文件输出，
 * 之后平台适配器 / core 逻辑等所有 logger 自动复用，日志统一落盘。
 */
let defaultTransports: LogTransport[] | null = null

/** 全局默认传输未初始化时的兜底控制台输出（单例复用） */
const consoleFallback: ConsoleTransport = new ConsoleTransport()

/** 日志消息语言（随应用语言设置变化，默认中文源消息） */
let logLocale: 'zh-CN' | 'en-US' = 'zh-CN'

/** 设置日志消息语言：en 开头视为英文，其余保持中文源消息 */
export function setLogLocale(locale: string): void {
  logLocale = locale.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

/** 按当前语言渲染日志消息；目录中缺失的消息原样输出 */
function translateMessage(message: string): string {
  if (logLocale !== 'en-US') return message
  return LOG_MESSAGE_EN[message] ?? message
}

export function setDefaultTransports(transports: LogTransport[]): void {
  defaultTransports = transports
}

export function getDefaultTransports(): LogTransport[] | null {
  return defaultTransports
}

function detectProcess(): LogProcess {
  if (isTestEnv()) return 'test'
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') return 'renderer'
  return 'main'
}

function extractErrorInfo(error: unknown): LogErrorInfo | undefined {
  if (error === undefined || error === null) return undefined
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  if (typeof error === 'string') return { name: 'Error', message: error }
  // 对象异常（如平台接口抛出的 { body: { code, message } }）：
  // 序列化记录真实内容（脱敏），避免被吞成 [object Object]
  try {
    const json = JSON.stringify(sanitizeContext(error as Record<string, unknown>))
    if (json !== undefined) {
      return { name: 'ObjectError', message: json.slice(0, 500) }
    }
  } catch {
    // 不可序列化对象走兜底
  }
  try {
    return { name: 'ObjectError', message: String(error).slice(0, 500) }
  } catch {
    return { name: 'ObjectError', message: '[unserializable error]' }
  }
}

class LoggerImpl implements Logger {
  private readonly base: {
    module: string
    level: LogLevel
    process: LogProcess
    context: LogContext
  }
  /** 显式传入的传输；缺省时每次输出动态解析全局默认传输（支持晚初始化） */
  private readonly explicitTransports?: LogTransport[]

  constructor(options: LoggerOptions) {
    this.base = {
      module: options.module,
      level: parseLogLevel(defaultLevelFromEnv(), options.level ?? 'info'),
      process: options.process ?? detectProcess(),
      context: options.baseContext ?? {},
    }
    this.explicitTransports = options.transports
  }

  private resolveTransports(): LogTransport[] {
    if (this.explicitTransports) return this.explicitTransports
    const defaults = getDefaultTransports()
    if (defaults) return defaults
    if (isTestEnv()) return []
    return [consoleFallback]
  }

  private emit(
    level: LogLevel,
    event: string,
    message: string,
    context?: LogContext,
    extra?: { durationMs?: number; error?: LogErrorInfo },
  ): void {
    if (!meetsLevel(level, this.base.level)) return

    const mergedContext = sanitizeContext({ ...this.base.context, ...context })
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.base.module,
      event,
      message: translateMessage(message),
      durationMs: extra?.durationMs,
      error: extra?.error,
      process: this.base.process,
    }
    if (Object.keys(mergedContext).length > 0) entry.context = mergedContext

    for (const transport of this.resolveTransports()) {
      try {
        transport.write(entry)
      } catch {
        // 日志输出失败绝不影响业务
      }
    }
  }

  debug(event: string, message: string, context?: LogContext): void {
    this.emit('debug', event, message, context)
  }

  info(event: string, message: string, context?: LogContext): void {
    this.emit('info', event, message, context)
  }

  warn(event: string, message: string, context?: LogContext): void {
    this.emit('warn', event, message, context)
  }

  error(event: string, message: string, error?: unknown, context?: LogContext): void {
    this.emit('error', event, message, context, { error: extractErrorInfo(error) })
  }

  child(context: LogContext): Logger {
    const childContext = { ...this.base.context, ...context }
    return new LoggerImpl({
      module: this.base.module,
      level: this.base.level,
      process: this.base.process,
      baseContext: childContext,
      transports: this.explicitTransports,
    })
  }

  async time<T>(
    event: string,
    task: () => Promise<T>,
    context?: LogContext,
    completeLevel: LogLevel = 'info',
  ): Promise<T> {
    const start = Date.now()
    this.debug(event, '开始', context)
    try {
      const result = await task()
      this.emit(completeLevel, event, '完成', context, { durationMs: Date.now() - start })
      return result
    } catch (e) {
      this.emit('error', event, '失败', context, {
        durationMs: Date.now() - start,
        error: extractErrorInfo(e),
      })
      throw e
    }
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new LoggerImpl(options)
}

export { LOG_LEVELS }
export type { LogContext, LogEntry, LogErrorInfo, Logger, LogLevel, LogProcess, LogTransport }
