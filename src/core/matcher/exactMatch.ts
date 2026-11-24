import { artistParts, normalize } from './matchSong'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'

/**
 * 金标准判定：标题归一化精确相等 + 歌手归一化精确相等 = 同一首歌，自动选择；
 * 标题精确相等但歌手不同 = 同曲不同作者（翻唱/重录），交由用户手动选择。
 * 行业真金标准 ISRC 国内平台 API 不暴露，故以此为代理金标准。
 */
export type CandidateDisposition =
  | { kind: 'exact'; songId: string }
  | { kind: 'title-only'; candidates: PlatformSong[] }
  | { kind: 'variant' }

/** 歌手串人名交集：feat./多人名顿号切分后任一人名归一化精确相等即视为同一歌手 */
function artistMatch(queryArtist: string | undefined, candidateArtist: string): boolean {
  if (!queryArtist) return false
  const queryParts = artistParts(queryArtist)
  const candidateParts = artistParts(candidateArtist)
  return queryParts.some((p) => candidateParts.includes(p))
}

export function classifyCandidates(
  query: MatchQuery,
  candidates: PlatformSong[],
): CandidateDisposition {
  const queryTitle = normalize(query.title)
  const queryArtist = query.artist ? normalize(query.artist) : ''

  const titleMatches = candidates.filter((c) => normalize(c.title) === queryTitle)

  if (queryArtist) {
    const exact = titleMatches.filter((c) => artistMatch(queryArtist, c.artist))
    if (exact.length > 0) {
      return { kind: 'exact', songId: pickByDuration(exact, query) }
    }
  } else if (titleMatches.length === 1) {
    return { kind: 'exact', songId: titleMatches[0].id }
  }

  if (titleMatches.length > 0) {
    return { kind: 'title-only', candidates: titleMatches }
  }

  return { kind: 'variant' }
}

/** 同一首歌多收录时，按时长最接近 query 者选择 */
function pickByDuration(songs: PlatformSong[], query: MatchQuery): string {
  if (songs.length === 1 || query.durationMs === undefined) return songs[0].id
  const target = query.durationMs
  return songs.reduce((best, s) => {
    const d = Math.abs((s.durationMs ?? Infinity) - target)
    const bd = Math.abs((best.durationMs ?? Infinity) - target)
    return d < bd ? s : best
  }).id
}
