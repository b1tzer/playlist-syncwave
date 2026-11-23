import { normalize } from '@core/matcher/matchSong'
import type { FieldOrder } from '@core/models/parse'
import { ARTIST_LEXICON } from './artistLexicon'

const VERSION_WORD = /(live|remix|cover|demo|acoustic|instrumental|ver\.|伴奏|现场版|纯音乐|演唱会|完整版)/i
// 仅顿号连接的中文人名（2~5 人）；英文逗号/斜杠常见于乐队名与歌名，不作多人名信号
const MULTI_ARTIST = /^[\u4e00-\u9fff·]{1,6}(?:、[\u4e00-\u9fff·]{1,6}){1,4}$/
const FEAT = /feat\.|featuring|ft\./i
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/g

function cjkLength(field: string): number {
  return field.match(CJK)?.length ?? 0
}

/** 单侧信号：该字段作为 title 或 artist 的证据分 */
function signalFor(field: string, role: 'title' | 'artist'): number {
  let score = 0
  if (role === 'title') {
    if (/《.+》/.test(field)) score += 0.4
    if (VERSION_WORD.test(field)) score += 0.35
    if (cjkLength(field) >= 8) score += 0.1
  } else {
    if (MULTI_ARTIST.test(field)) score += 0.35
    if (FEAT.test(field)) score += 0.3
    if (ARTIST_LEXICON.has(normalize(field))) score += 0.3
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
 * 多数定序（占比 ≥80% 且样本 ≥2）用于裁决歧义行。
 */
export function majorityOrder(orders: Array<FieldOrder | 'ambiguous'>): FieldOrder | undefined {
  const decided = orders.filter((o): o is FieldOrder => o !== 'ambiguous')
  if (decided.length < 2) return undefined
  const titleFirstCount = decided.filter((o) => o === 'title-first').length
  if (titleFirstCount / decided.length >= 0.8) return 'title-first'
  if ((decided.length - titleFirstCount) / decided.length >= 0.8) return 'artist-first'
  return undefined
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
