import type { FieldOrder } from '@core/models/parse'

// 英文版本词加词边界（避免 Deliver/Recover/Forever. 词根误匹配）；中文词保持子串匹配
const VERSION_WORD_EN = /\b(live|remix|cover|demo|acoustic|instrumental|ver\.?)\b/i
const VERSION_WORD_CN = /(伴奏|现场版|现场|翻唱|纯音乐|演唱会|完整版)/
// 仅顿号连接的中文人名（2~5 人）；英文逗号/斜杠常见于乐队名与歌名，不作多人名信号
const MULTI_ARTIST = /^[\u4e00-\u9fff·]{1,6}(?:、[\u4e00-\u9fff·]{1,6}){1,4}$/
const FEAT = /feat\.|featuring|ft\./i
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/g

function cjkLength(field: string): number {
  return field.match(CJK)?.length ?? 0
}

/**
 * 单侧信号：该字段作为 title 或 artist 的证据分。
 * 字段顺序的最终裁决不依赖本地词典，交由同步阶段的平台搜索验证闭环完成；
 * 此处仅保留强结构信号（书名号/版本词/多人名/feat/长度）。
 */
function signalFor(field: string, role: 'title' | 'artist'): number {
  let score = 0
  if (role === 'title') {
    if (/《.+》/.test(field)) score += 0.4
    if (VERSION_WORD_EN.test(field) || VERSION_WORD_CN.test(field)) score += 0.35
    if (cjkLength(field) >= 8) score += 0.1
  } else {
    if (MULTI_ARTIST.test(field)) score += 0.35
    if (FEAT.test(field)) score += 0.3
    if (cjkLength(field) <= 3) score += 0.1
  }
  return score
}

export interface PairInference {
  order: FieldOrder | 'ambiguous'
  /** 0~0.95，定序时为 0.75~0.95，歧义时低于 0.6 */
  confidence: number
}

/**
 * 字段顺序自动判定：两侧信号加权，差值 ≥0.25 定序，否则标记歧义。
 * 用户无需手动指定「歌名 - 歌手」或「歌手 - 歌名」。
 */
export function inferPair(first: string, second: string): PairInference {
  const titleFirst = signalFor(first, 'title') + signalFor(second, 'artist')
  const artistFirst = signalFor(first, 'artist') + signalFor(second, 'title')
  const diff = titleFirst - artistFirst
  if (Math.abs(diff) >= 0.25) {
    return {
      order: diff > 0 ? 'title-first' : 'artist-first',
      confidence: Math.min(0.5 + Math.abs(diff), 0.95),
    }
  }
  return { order: 'ambiguous', confidence: 0.5 - Math.abs(diff) }
}

/**
 * 整段一致性投票：同一来源文本字段顺序基本一致，
 * 多数定序（占比 ≥60% 且样本 ≥2）用于裁决歧义行。
 */
export function majorityOrder(orders: Array<FieldOrder | 'ambiguous'>): FieldOrder | undefined {
  const decided = orders.filter((o): o is FieldOrder => o !== 'ambiguous')
  if (decided.length < 2) return undefined
  const titleFirstCount = decided.filter((o) => o === 'title-first').length
  if (titleFirstCount / decided.length >= 0.6) return 'title-first'
  if ((decided.length - titleFirstCount) / decided.length >= 0.6) return 'artist-first'
  return undefined
}

/**
 * 歧义行的默认顺序启发式：
 * 双字段均无中文（英文 tracklist/m3u 常见「歌手 - 歌名」）→ artist-first；
 * 其余（中文 App 分享常见「歌名 - 歌手」）→ title-first。
 * 仅影响预览默认展示，同步阶段仍由备选候选验证闭环裁决。
 */
export function defaultOrderForPair(first: string, second: string): FieldOrder {
  const hasCjk = /[\u4e00-\u9fff]/.test(first) || /[\u4e00-\u9fff]/.test(second)
  return hasCjk ? 'title-first' : 'artist-first'
}

/**
 * 书名号锚定：《歌名》歌手 / 歌手《歌名》 → 高置信度提取歌名。
 */
export function splitQuotedTitle(
  cleaned: string,
): { title: string; artist?: string } | null {
  const leading = cleaned.match(/^《([^》]{1,60})》(.*)$/)
  if (leading) {
    const artist = leading[2]?.trim()
    return { title: leading[1], artist: artist || undefined }
  }
  const trailing = cleaned.match(/^(.*)《([^》]{1,60})》$/)
  if (trailing) {
    const artist = trailing[1]?.trim()
    return { title: trailing[2], artist: artist || undefined }
  }
  return null
}
