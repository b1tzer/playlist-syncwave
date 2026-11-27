/**
 * 上游发行时间归一化为 yyyy-MM-dd：
 * 兼容「yyyy-MM-dd / yyyy.MM.dd」字符串与秒/毫秒时间戳（网易云 publishTime 为毫秒）。
 * 时间戳按东八区（北京时间）取日期：上游均为国内平台，发行日期按数据源时区呈现，
 * 避免 UTC 切片把凌晨发行的歌曲算到前一天。
 * 无法识别时返回 undefined（渲染层隐藏发行时间行）。
 */
const CN_OFFSET_MS = 8 * 3600_000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function normalizeReleaseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const text = String(raw).trim()
  if (!text) return undefined
  // 时间戳：13 位为毫秒，10~12 位为秒（按位数判定，与正则口径一致）
  if (/^\d{10,13}$/.test(text)) {
    const ms = text.length >= 13 ? Number(text) : Number(text) * 1000
    if (!Number.isFinite(ms)) return undefined
    const date = new Date(ms + CN_OFFSET_MS)
    if (Number.isNaN(date.getTime())) return undefined
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  }
  // 常见日期分隔格式
  const match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined
  }
  // 回读校验：拦截 2 月 30 日这类日历上不存在的日期
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined
  return `${year}-${pad(month)}-${pad(day)}`
}
