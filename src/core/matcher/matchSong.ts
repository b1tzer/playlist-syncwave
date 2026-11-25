import { Converter } from 'opencc-js'
import type { CandidateSong, MatchOptions, MatchQuery, MatchResult } from '@core/models/match'
import { SYNC_TUNING_DEFAULTS } from '@core/sync/tuning'

const t2s = Converter({ from: 'tw', to: 'cn' })

const FULLWIDTH = /[\uFF01-\uFF5E]/g
const PAREN_CONTENT = /\s*[(（【[].*?[)）】\]]\s*/g
const HAS_PAREN = /[(（【[].*?[)）】\]]/

/** 保留括号内容的原始键：小写、繁转简、全角转半角、去空白 */
function rawKey(text: string): string {
  return t2s(text)
    .toLowerCase()
    .replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/gu, '')
}

/** 归一化：rawKey 基础上再去除括号内容。保留标点。 */
export function normalize(text: string): string {
  return rawKey(text).replace(PAREN_CONTENT, '')
}

/**
 * 歌手串切分为多个人名：先整串归一化，再按 feat/连接符切分。
 * 顿号切分多人名合唱（周杰伦、温岚）；斜杠不切（乐队名常见斜杠）。
 */
const FEAT_SPLIT = /feat\.?|ft\.?|featuring|&|,|;|、/i

export function artistParts(artist: string): string[] {
  return normalize(artist)
    .split(FEAT_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** 歌手串人名交集：任一人名归一化精确相等即视为同一歌手 */
export function artistExactMatch(
  queryArtist: string | undefined,
  candidateArtist: string,
): boolean {
  if (!queryArtist) return false
  const queryParts = artistParts(queryArtist)
  const candidateParts = artistParts(candidateArtist)
  return queryParts.some((p) => candidateParts.includes(p))
}

/** 版本标记词表：标题括号内出现即视为该版本；先匹配长词（remastered 先于 remaster） */
const VERSION_TAGS = [
  'remastered',
  'instrumental',
  'acoustic',
  'unplugged',
  'radioedit',
  'remaster',
  'remix',
  'cover',
  'live',
  'dj',
  '伴奏',
  '翻唱',
  '现场',
  '纯音乐',
]

/** 提取标题括号内的版本标记；无则返回 undefined */
export function extractVersionTag(title: string): string | undefined {
  for (const match of title.matchAll(/[(（【[]([^)）】\]]+)[)）】\]]/g)) {
    const inner = normalize(match[1])
    if (!inner) continue
    for (const tag of VERSION_TAGS) {
      if (inner === tag || inner.includes(tag)) return tag
    }
  }
  return undefined
}

function fuzzyScore(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (longer.includes(shorter)) return 0.6
  return 0
}

export function findBestMatch(
  query: MatchQuery,
  candidates: CandidateSong[],
  options: MatchOptions = {},
): MatchResult | null {
  const threshold = options.threshold ?? SYNC_TUNING_DEFAULTS.threshold
  const queryTitle = normalize(query.title)
  const queryHasParen = HAS_PAREN.test(query.title)
  const queryTag = extractVersionTag(query.title)

  let best: MatchResult | null = null

  for (const c of candidates) {
    const candidateTitle = normalize(c.title)
    const candidateArtist = normalize(c.artist)
    const reasons: string[] = []

    const titleScore = fuzzyScore(queryTitle, candidateTitle)
    let score: number
    if (titleScore === 1) {
      if (rawKey(query.title) === rawKey(c.title)) {
        score = 0.8
        reasons.push('title-exact')
      } else {
        score = 0.7
        reasons.push('title-variant')
      }
    } else if (titleScore > 0) {
      score = 0.5
      reasons.push('title-partial')
    } else {
      score = 0
    }

    if (query.artist && candidateArtist) {
      const queryParts = artistParts(query.artist)
      const candidateParts = artistParts(c.artist)
      if (artistExactMatch(query.artist, c.artist)) {
        score += 0.15
        reasons.push('artist-exact')
      } else if (queryParts.some((p) => candidateParts.some((cp) => fuzzyScore(p, cp) > 0))) {
        score += 0.05
        reasons.push('artist-partial')
      }
    }

    if (query.album && c.album) {
      const queryAlbum = normalize(query.album)
      const candidateAlbum = normalize(c.album)
      if (queryAlbum === candidateAlbum) {
        score += 0.05
        reasons.push('album-exact')
      } else if (fuzzyScore(queryAlbum, candidateAlbum) > 0) {
        score += 0.02
        reasons.push('album-partial')
      }
    }

    if (query.durationMs !== undefined && c.durationMs !== undefined) {
      if (Math.abs(c.durationMs - query.durationMs) <= 1_000) {
        score += 0.02
        reasons.push('duration-match')
      }
    }

    if (queryTag !== undefined) {
      const candidateTag = extractVersionTag(c.title)
      if (candidateTag === queryTag) {
        score += 0.08
        reasons.push('version-match')
      } else if (candidateTag !== undefined) {
        score -= 0.05
        reasons.push('version-mismatch')
      }
    }

    if (queryHasParen) score -= 0.02
    score = Math.min(1, Math.max(0, score))

    if (!best || score > best.score) {
      best = { candidate: c, score, matched: score >= threshold, reasons }
    }
  }

  return best
}
