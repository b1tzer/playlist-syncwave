export interface CandidateSong {
  /** 平台歌曲 ID */
  id: string
  title: string
  artist: string
  album?: string
  durationMs?: number
}

export interface MatchQuery {
  title: string
  artist?: string
  durationMs?: number
}

export interface MatchResult {
  candidate: CandidateSong
  /** 0~1 的匹配得分 */
  score: number
  /** 是否达到可接受阈值 */
  matched: boolean
  /** 命中的匹配因子，便于调试与展示 */
  reasons: string[]
}

export interface MatchOptions {
  /** 接受阈值，默认 0.6 */
  threshold?: number
}
