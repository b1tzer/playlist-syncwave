import { sanitizeContext, sanitizeValue } from './redact'
import type { Logger } from './types'

/** 出入参正文截断上限（字节）：歌单/搜索等响应可能很大，防止 error 日志膨胀 */
export const HTTP_ERROR_MAX_BODY_BYTES = 8 * 1024

/**
 * 开发模式判断：完整出入参只在开发环境记录（与主进程 isDev 的
 * `process.env.NODE_ENV === 'development'` 判断一致；core 层不依赖 Electron API）。
 */
export function isDevMode(): boolean {
  return typeof process !== 'undefined' && process.env?.NODE_ENV === 'development'
}

/** 请求失败时的完整请求信息：method/url 始终记录，headers/body 仅在开发模式落盘 */
export interface HttpErrorContext {
  method: string
  /** 请求地址（库函数直调的平台可用接口名代替） */
  url: string
  /** 入参（对象/数组/字符串均可） */
  requestBody?: unknown
  /** 请求头（敏感字段如 authorization/cookie 会被脱敏） */
  requestHeaders?: Record<string, unknown>
  /** HTTP 状态码 */
  status?: number
  /** 出参响应体 */
  responseBody?: unknown
  durationMs?: number
}

/**
 * 出入参序列化：先脱敏（敏感 key 递归掩码）再 JSON 化，超长截断。
 * 任何序列化异常降级为 String 兜底，保证日志链路不中断业务。
 */
function stringifyBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  try {
    const sanitized = typeof body === 'string' ? body : sanitizeValue(body)
    const json = JSON.stringify(sanitized)
    if (json === undefined) return undefined
    if (json.length > HTTP_ERROR_MAX_BODY_BYTES) {
      return `${json.slice(0, HTTP_ERROR_MAX_BODY_BYTES)}…(truncated)`
    }
    return json
  } catch {
    try {
      const text = String(body).slice(0, 500)
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * 记录请求失败详情：
 * - 生产环境：仅 method/url/status/durationMs 精简信息；
 * - 开发环境：额外记录完整出入参（requestHeaders/requestBody/responseBody），
 *   敏感字段沿用 sanitizeContext 掩码，正文超 8KB 截断。
 * 内部兜底保证绝不抛异常、不中断业务。
 */
export function logHttpError(
  logger: Logger,
  event: string,
  message: string,
  error: unknown,
  http: HttpErrorContext,
): void {
  try {
    const context: Record<string, unknown> = {
      method: http.method,
      url: http.url,
    }
    if (http.status !== undefined) context.status = http.status
    if (http.durationMs !== undefined) context.durationMs = http.durationMs
    if (isDevMode()) {
      const requestHeaders = stringifyBody(http.requestHeaders)
      const requestBody = stringifyBody(http.requestBody)
      const responseBody = stringifyBody(http.responseBody)
      if (requestHeaders !== undefined) context.requestHeaders = requestHeaders
      if (requestBody !== undefined) context.requestBody = requestBody
      if (responseBody !== undefined) context.responseBody = responseBody
    }
    logger.error(event, message, error, sanitizeContext(context))
  } catch {
    // 极端情况兜底：最小 context 再试一次，仍失败则静默
    try {
      logger.error(event, message, error, { method: http.method, url: http.url })
    } catch {
      // 日志链路失败绝不中断业务
    }
  }
}
