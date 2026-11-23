import { Converter } from 'opencc-js'
import type { CandidateSong, MatchOptions, MatchQuery, MatchResult } from '@core/models/match'

const t2s = Converter({ from: 'tw', to: 'cn' })

const FULLWIDTH =
  /[\uFF01-\uFF5E]/g
const PAREN_CONTENT = /\s*[（(【\[].*?[)）】\]]\s*/g

/** 归一化：小写、去空白标点、繁转简、全角转半角、去括号内容 */
export function normalize(text: string): string {
  return t2s(text)
    .toLowerCase()
    .replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(PAREN_CONTENT, '')
    .replace(/[\s\p{P}]+/gu, '')
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

  let best: MatchResult | null = null

  for (const c of candidates) {
    const candidateTitle = normalize(c.title)
    const candidateArtist = normalize(c.artist)
    const reasons: string[] = []

    const titleScore = fuzzyScore(queryTitle, candidateTitle)
    if (titleScore === 0) continue
    reasons.push('title-match')

    let score = titleScore * 0.7
    if (titleScore === 1) score = 0.8

    let artistScore = 0
    if (queryArtist && candidateArtist) {
      artistScore = fuzzyScore(queryArtist, candidateArtist)
      if (artistScore === 1) {
        score += 0.2
        reasons.push('artist-match')
      } else if (artistScore > 0) {
        score += 0.05
        reasons.push('artist-partial')
      }
    } else if (queryArtist && !candidateArtist) {
      score -= 0.1
    }

    if (query.durationMs !== undefined && c.durationMs !== undefined) {
      const delta = Math.abs(c.durationMs - query.durationMs)
      if (delta <= 1_000) {
        score += 0.02
        reasons.push('duration-match')
      }
    }

    score = Math.min(1, Math.max(0, score))

    if (!best || score > best.score) {
      best = { candidate: c, score, matched: score >= threshold, reasons }
    }
  }

  return best
}
