import type { MatchQuery } from './match'
import type { PlatformSong } from './platform'

/** 缓存命中的映射结果 */
export interface MappingHit {
  songId: string
  /** 人工确认的映射（优先采用，无需再搜索验证） */
  confirmed: boolean
}

/** 同步引擎依赖的目标平台能力（core 内定义，主进程用 adapter 包装注入） */
export interface SyncTarget {
  /** 搜索候选歌曲 */
  searchSongs(keyword: string, limit?: number): Promise<PlatformSong[]>
  /** 创建歌单，返回新歌单 ID */
  createPlaylist(name: string): Promise<string>
  /** 批量添加歌曲 */
  addSongs(playlistId: string, songIds: string[]): Promise<void>
  /** 查询映射缓存（可选）：命中人工确认映射时跳过搜索 */
  lookupMapping?(query: MatchQuery): MappingHit | null
  /** 记录自动匹配结果到缓存（可选） */
  saveMapping?(query: MatchQuery, songId: string): void
}

export interface SyncFailedItem {
  query: MatchQuery
  reason: 'search-failed' | 'no-match' | 'rate-limited' | 'unresolved'
  message: string
}

/** 同歌不同作者：需要用户手动选择的目标候选 */
export interface SyncChoice {
  query: MatchQuery
  candidates: PlatformSong[]
}

/** 用户对某个 choice 的选择 */
export interface SyncSelection {
  /** plan.choices 的下标 */
  choiceIndex: number
  songId: string
}

/** 同步计划：搜索+金标准判定后的产物（未建单） */
export interface SyncPlan {
  total: number
  matched: Array<{ query: MatchQuery; songId: string }>
  choices: SyncChoice[]
  failed: SyncFailedItem[]
}

export interface SyncReport {
  /** done：已建单完成；choice-needed：存在同歌不同作者，等待手动选择 */
  status: 'done' | 'choice-needed'
  /** 歌单名 */
  playlistName: string
  /** 新歌单 ID（未建单时为空串） */
  playlistId: string
  total: number
  matched: number
  added: number
  failed: SyncFailedItem[]
  /** status 为 choice-needed 时非空 */
  choices: SyncChoice[]
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

/** 同步任务状态（同步中心展示 + SQLite 持久化共用） */
export type SyncTaskStatus = 'running' | 'done' | 'failed'

export interface SyncTaskRecord {
  id: string
  name: string
  /** 目标平台 id */
  targetPlatform: string
  /** 来源描述，如「文本导入」 */
  source: string
  status: SyncTaskStatus
  total: number
  added: number
  failed: number
  createdAt: string
  /** 0-1，运行中更新 */
  progress: number
  failedDetail: string[]
}
