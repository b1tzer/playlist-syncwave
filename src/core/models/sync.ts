import type { MatchQuery } from './match'
import type { PlatformSong } from './platform'

/** 同步引擎依赖的目标平台能力（core 内定义，主进程用 adapter 包装注入） */
export interface SyncTarget {
  /** 搜索候选歌曲 */
  searchSongs(keyword: string, limit?: number): Promise<PlatformSong[]>
  /** 创建歌单，返回新歌单 ID */
  createPlaylist(name: string): Promise<string>
  /** 批量添加歌曲 */
  addSongs(playlistId: string, songIds: string[]): Promise<void>
}

export interface SyncFailedItem {
  query: MatchQuery
  reason: 'search-failed' | 'no-match' | 'rate-limited'
  message: string
}

export interface SyncReport {
  /** 歌单名 */
  playlistName: string
  /** 新歌单 ID */
  playlistId: string
  total: number
  matched: number
  added: number
  failed: SyncFailedItem[]
}

export interface SyncOptions {
  /** 匹配阈值，默认 0.6 */
  threshold?: number
  /** 每批添加歌曲数，默认 500 */
  batchSize?: number
  /** 相邻两次搜索的最小间隔（毫秒），默认 500，用于避免触发平台风控 */
  searchIntervalMs?: number
  /** 单首歌搜索重试次数（仅对可重试错误），默认 2 */
  searchRetries?: number
  /** 进度回调：0~1 */
  onProgress?: (ratio: number, stage: 'matching' | 'adding') => void
}

/** 平台搜索异常（含可重试标记） */
export class SearchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'SearchError'
  }
}

/** 同步输入：解析器输出的歌单请求（歌名+歌手） */
export type SyncInput = MatchQuery[]
