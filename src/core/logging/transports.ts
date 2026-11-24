import { formatConsole } from './format'
import type { LogEntry, LogTransport } from './types'

/** 检测测试环境（vitest），避免测试输出被日志淹没 */
export function isTestEnv(): boolean {
  if (typeof process === 'undefined') return false
  return process.env?.['VITEST'] === 'true' || process.env?.['NODE_ENV'] === 'test'
}

function consoleFor(level: LogEntry['level']): typeof console.info {
  switch (level) {
    case 'debug':
      return console.debug
    case 'warn':
      return console.warn
    case 'error':
      return console.error
    default:
      return console.info
  }
}

/**
 * 控制台输出：主进程打到终端，渲染进程打到 DevTools。
 * 所有支持 console 的环境均可用（跨操作系统无差异）。
 */
export class ConsoleTransport implements LogTransport {
  readonly name = 'console'

  write(entry: LogEntry): void {
    consoleFor(entry.level)(formatConsole(entry))
  }
}

export function createConsoleTransport(): ConsoleTransport {
  return new ConsoleTransport()
}
