import { Converter } from 'opencc-js'
import type { CandidateSong, MatchOptions, MatchQuery, MatchResult } from '@core/models/match'

const t2s = Converter({ from: 'tw', to: 'cn' })

const FULLWIDTH = /[\uFF01-\uFF5E]/g
const PAREN_CONTENT = /\s*[(（【[].*?[)）】\]]\s*/g
const HAS_PAREN = /[(（【[].*?[)）】\]]/

/** 归一化：小写、去空白、繁转简、全角转半角、去括号内容。保留标点。 */
export function normalize(text: string): string {
  return t2s(text)
    .toLowerCase()
    .replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(PAREN_CONTENT, '')
    .replace(/\s+/gu, '')
}

/** 保留括号内容的原始键，用于区分「精确标题」与「括号变体」 */
function rawKey(text: string): string {
  return t2s(text)
    .toLowerCase()
    .replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/gu, '')
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
  const threshold = options.threshold ?? 0.6
  const queryTitle = normalize(query.title)
  const queryArtist = query.artist ? normalize(query.artist) : ''
  const queryHasParen = HAS_PAREN.test(query.title)

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

    if (queryArtist && candidateArtist) {
      const artistScore = fuzzyScore(queryArtist, candidateArtist)
      if (artistScore === 1) {
        score += 0.15
        reasons.push('artist-exact')
      } else if (artistScore > 0) {
        score += 0.05
        reasons.push('artist-partial')
      }
    }

    if (query.durationMs !== undefined && c.durationMs !== undefined) {
      if (Math.abs(c.durationMs - query.durationMs) <= 1_000) {
        score += 0.02
        reasons.push('duration-match')
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
