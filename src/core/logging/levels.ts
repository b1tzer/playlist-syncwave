import type { LogLevel } from './types'

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LOG_LEVELS
}

/** 解析日志级别：环境变量 LOG_LEVEL 优先，非法值回退 fallback */
export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  return value && isLogLevel(value) ? value : fallback
}

export function meetsLevel(entryLevel: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS[entryLevel] >= LOG_LEVELS[threshold]
}
