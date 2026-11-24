/**
 * 日志核心类型定义。
 * 该模块不依赖 Node/Electron API，可在主进程、渲染进程与测试环境（Node）复用，
 * 保证各平台（macOS/Windows/Linux）与各音乐平台适配器输出一致的日志结构。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志产生的运行环境 */
export type LogProcess = 'main' | 'renderer' | 'test'

export interface LogErrorInfo {
  name: string
  message: string
  stack?: string
}

/**
 * 一条结构化日志记录。
 * 必备要素：
 * - timestamp：ISO 8601 毫秒级时间戳（UTC）
 * - level：级别
 * - module：来源模块（如 sync.playlist、platform.netease）
 * - event：操作/事件标识（如 login.qr.create）
 * - message：人类可读描述
 * - context：结构化上下文（已脱敏）
 * - durationMs：操作耗时
 * - error：错误信息（name/message/stack）
 * - process/platform/appVersion：运行环境信息
 */
export interface LogEntry {
  timestamp: string
  level: LogLevel
  module: string
  event: string
  message: string
  context?: Record<string, unknown>
  durationMs?: number
  error?: LogErrorInfo
  process: LogProcess
  /** 操作系统平台：darwin / win32 / linux */
  platform?: string
  /** 应用版本号 */
  appVersion?: string
}

export type LogContext = Record<string, unknown>

export interface Logger {
  debug(event: string, message: string, context?: LogContext): void
  info(event: string, message: string, context?: LogContext): void
  warn(event: string, message: string, context?: LogContext): void
  error(event: string, message: string, error?: unknown, context?: LogContext): void
  /** 派生带固定上下文的子 logger */
  child(context: LogContext): Logger
  /**
   * 包裹异步操作：记录开始（debug）、完成（默认 info+耗时）与失败（error+耗时）。
   * completeLevel 用于高频轮询类操作，避免 info 日志刷屏。
   */
  time<T>(
    event: string,
    task: () => Promise<T>,
    context?: LogContext,
    completeLevel?: LogLevel,
  ): Promise<T>
}

export interface LogTransport {
  readonly name: string
  write(entry: LogEntry): void
  flush?(): void | Promise<void>
}

export interface LoggerOptions {
  module: string
  /** 低于该级别的日志被丢弃，默认 'info' */
  level?: LogLevel
  process?: LogProcess
  /** 每条日志都会携带的基础上下文（如 platform、appVersion） */
  baseContext?: LogContext
  /** 输出通道；缺省时使用全局默认传输或自动控制台 */
  transports?: LogTransport[]
}
