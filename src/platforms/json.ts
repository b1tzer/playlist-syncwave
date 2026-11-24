/**
 * 平台响应 JSON 的容错读取工具：各平台适配器共用，
 * 保证字段缺失/类型不符时安全兜底。
 */

export type JsonObject = Record<string, unknown>

/** 非对象值归一为空对象，便于链式取值 */
export function asObject(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null ? (v as JsonObject) : {}
}

/** 依次取值，返回第一个非空字符串（数字转字符串） */
export function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

/** 非数组归一为空数组 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 歌手对象数组 → 顿号分隔的人名串（如 [{name:'A'},{name:'B'}] → 'A / B'） */
export function artistNames(list: unknown[]): string {
  return list
    .map((a) => pickString(asObject(a).name))
    .filter((n): n is string => Boolean(n))
    .join(' / ')
}
