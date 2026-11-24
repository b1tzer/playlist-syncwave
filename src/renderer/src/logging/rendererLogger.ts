import {
  createConsoleTransport,
  createLogger,
  setDefaultTransports,
  type LogEntry,
  type Logger,
  type LogTransport,
} from '@core/logging'

/**
 * 渲染进程日志传输：经 preload 暴露的 IPC 通道投递到主进程，
 * 由主进程校验后与主进程日志一并落盘。
 */
class IpcLogTransport implements LogTransport {
  readonly name = 'ipc'

  write(entry: LogEntry): void {
    try {
      window.electronAPI.log(entry)
    } catch {
      // preload 未就绪或通道异常时静默
    }
  }
}

const ipcTransport = new IpcLogTransport()

/** 渲染进程默认传输：开发环境控制台 + IPC 落盘留痕 */
function buildTransports(): LogTransport[] {
  const transports: LogTransport[] = []
  if (import.meta.env?.DEV) transports.push(createConsoleTransport())
  transports.push(ipcTransport)
  return transports
}

/**
 * 安装渲染进程全局默认传输：
 * 渲染进程中未显式指定传输的 logger（如 core 的 parser）也统一经 IPC 落盘。
 */
export function installRendererLogging(): void {
  setDefaultTransports(buildTransports())
}

/** 渲染进程日志工厂：开发环境输出到控制台并使用 debug 级别，始终经 IPC 落盘留痕 */
export function createRendererLogger(module: string): Logger {
  const dev = Boolean(import.meta.env?.DEV)
  return createLogger({
    module,
    process: 'renderer',
    level: dev ? 'debug' : 'info',
    transports: buildTransports(),
  })
}

/** 渲染进程全局异常兜底：窗口错误与未处理拒绝进入日志 */
export function installRendererErrorHandlers(logger: Logger): void {
  window.addEventListener('error', (event) => {
    logger.error('renderer.window-error', '窗口运行时错误', event.error ?? event.message, {
      source: event.filename,
      line: event.lineno,
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('renderer.unhandled-rejection', '未处理的 Promise 拒绝', event.reason)
  })
}
