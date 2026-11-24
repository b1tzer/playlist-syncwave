/**
 * 敏感信息脱敏：凭证（cookie/token/session 等）绝不落入日志文件。
 * 仅对敏感 key 的值做掩码，其余值原样保留；
 * 递归处理对象/数组，限制深度并兜底循环引用与不可序列化值。
 */

const SENSITIVE_KEY = /cookie|token|secret|passw(or)?d|credential|authorization|session|qrimg/i

const MAX_DEPTH = 6

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

function maskString(value: string): string {
  if (value.length === 0) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

/** 敏感值：递归掩码其中所有字符串（含嵌套子树） */
function maskValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return maskString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value}n`
  if (depth >= MAX_DEPTH) return String(value).slice(0, 200)

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, depth + 1))
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskValue(item, depth + 1)
    }
    return out
  }

  return String(value).slice(0, 200)
}

/** 非敏感值：原样保留，仅做可序列化兜底 */
function safeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'bigint') return `${value}n`
  if (depth >= MAX_DEPTH) return String(value).slice(0, 200)

  if (Array.isArray(value)) {
    return value.map((item) => safeValue(item, depth + 1))
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? maskValue(item, MAX_DEPTH) : safeValue(item, depth + 1)
    }
    return out
  }

  // function / symbol 等不可序列化值
  return String(value).slice(0, 200)
}

/**
 * 对日志上下文做安全处理：敏感字段脱敏 + 可序列化兜底。
 * 任何情况下不抛异常，保证日志链路永不中断业务。
 */
export function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {}
  try {
    const masked: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(context)) {
      masked[key] = isSensitiveKey(key) ? maskValue(value, MAX_DEPTH) : safeValue(value, 0)
    }
    // 循环引用等极端情况：丢字段兜底
    JSON.stringify(masked)
    return masked
  } catch {
    try {
      return { raw: String(context).slice(0, 500) }
    } catch {
      return { raw: '[unserializable context]' }
    }
  }
}
