import type { MatchQuery } from './match'
import type { PlatformSong } from './platform'

/** 缓存命中的映射结果 */
export interface MappingHit {
  songId: string
  /** 人工确认的映射（优先采用，无需再搜索验证） */
  confirmed: boolean
  /** 命中映射对应的目标资源关键信息（重新执行复用时透传，供明细展示与再次复用） */
  resource?: SyncMatchedResource
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

export type SyncFailedReason =
  | 'search-failed'
  | 'add-failed'
  | 'no-match'
  | 'rate-limited'
  | 'unresolved'
  | 'skipped'
  /** 任务整体异常（建单/写入阶段崩溃）：明细收敛时用于标记未完成项 */
  | 'task-failed'

export interface SyncFailedItem {
  query: MatchQuery
  /** search-failed：搜索失败；add-failed：写入歌单失败；no-match：未匹配；rate-limited：限流；unresolved：未选择；skipped：用户跳过 */
  reason: SyncFailedReason
  message: string
}

/** 匹配到的目标平台资源关键信息：重新执行时可直接复用，无需重新搜索 */
export interface SyncMatchedResource {
  /** 目标平台上的歌曲标题 */
  title?: string
  /** 目标平台上的歌手 */
  artist?: string
  /** 目标平台上的专辑 */
  album?: string
}

/** 每首歌的处理明细：同步历史任务详情清单的最小单元 */
export interface SyncItemResult {
  /** 输入列表下标（0-based） */
  index: number
  query: MatchQuery
  /** matched：已匹配；choice：同歌不同作者待选择；failed：失败；skipped：用户跳过 */
  status: 'matched' | 'choice' | 'failed' | 'skipped'
  reason?: SyncFailedReason
  message?: string
  /** 匹配到的平台歌曲 ID（matched 时存在） */
  songId?: string
  /** 匹配到的目标资源关键信息（matched 时存在；映射缓存命中时可能缺失） */
  matchedSong?: SyncMatchedResource
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
  /** 用户显式跳过该首（不写入任何版本）：songId 为空，执行时记为 skipped 失败项 */
  skipped?: boolean
}

/** 同步计划：搜索+金标准判定后的产物（未建单） */
export interface SyncPlan {
  total: number
  matched: Array<{ query: MatchQuery; songId: string }>
  choices: SyncChoice[]
  failed: SyncFailedItem[]
  /** 逐首处理明细（含 matched/choice/failed/skipped 全部歌曲） */
  items: SyncItemResult[]
  /** 第一首歌曲的匹配结果风格（用于自动命名歌单） */
  firstGenre?: string
}

export interface SyncReport {
  /** done：已建单完成；choice-needed：存在同歌不同作者，等待手动选择；stopped：用户主动停止 */
  status: 'done' | 'choice-needed' | 'stopped'
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
  /** 逐首处理明细（详情清单） */
  items: SyncItemResult[]
  /** 第一首歌曲的匹配结果风格（用于自动命名歌单） */
  firstGenre?: string
}

/** 同步执行检查点：供主进程定期持久化，中断后恢复执行所需的最小状态 */
export interface SyncCheckpoint {
  /** 当前阶段：created 建单完成 / matching 逐首搜索 / adding 写入歌单 */
  stage: 'created' | 'matching' | 'adding'
  /** created/adding 阶段：已创建的目标歌单 ID */
  playlistId?: string
  /** adding 阶段：已成功添加的歌曲数 */
  added?: number
}

export interface SyncOptions {
  /** 匹配阈值，默认 0.6 */
  threshold?: number
  /** 每批添加歌曲数，默认 500 */
  batchSize?: number
  /** 全局相邻两次搜索请求的最小间隔（毫秒），默认 500，用于避免触发平台风控（并发池内所有搜索共享） */
  searchIntervalMs?: number
  /** 匹配阶段并发处理的歌曲数（受控并发池），默认 3，最小 1 */
  searchConcurrency?: number
  /** 单首歌搜索重试次数（仅对可重试错误），默认 2 */
  searchRetries?: number
  /** 单首歌最大搜索次数预算（主/备选候选 × 关键词），默认 4，防止风控 */
  maxSearchesPerSong?: number
  /** 进度回调：0~1 */
  onProgress?: (ratio: number, stage: 'matching' | 'adding') => void
  /** 中止信号：触发后引擎在下一个检查点停止并抛 SyncAbortedError */
  signal?: AbortSignal
  /** 每首歌开始前询问：返回 true 表示用户请求跳过该首（记为 skipped 失败项，不搜索） */
  skipCheck?: () => boolean
  /** 逐首明细回调（matched/choice/failed/skipped 各触发一次） */
  onStep?: (item: SyncItemResult) => void
  /** 检查点回调：阶段切换与批次写入后触发，主进程据此定期保存状态 */
  onCheckpoint?: (checkpoint: SyncCheckpoint) => void
  /** 复用调用方已创建的目标歌单：执行阶段跳过建单（先建单再匹配流程专用） */
  existingPlaylistId?: string
}

/** 引擎被中止（用户停止任务）时抛出；partial 携带已产生的明细供收敛为 stopped 报告 */
export class SyncAbortedError extends Error {
  constructor(
    public readonly partial: {
      items: SyncItemResult[]
      failed: SyncFailedItem[]
      total: number
      matched?: number
      added?: number
      playlistId?: string
    },
  ) {
    super('同步任务已停止')
    this.name = 'SyncAbortedError'
  }
}

/** 平台搜索异常（含可重试标记与限流标记，由各平台适配器判定） */
export class SearchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    /** 操作频繁被限流（平台风控），重试前需等待更长时间 */
    public readonly rateLimited = false,
  ) {
    super(message)
    this.name = 'SearchError'
  }
}

/** 同步输入：解析器输出的歌单请求（歌名+歌手） */
export type SyncInput = MatchQuery[]

/**
 * 同步任务状态（同步历史展示 + SQLite 持久化共用）
 * - running：执行中（含等待用户确认选择）
 * - done：已完成
 * - failed：执行异常（匹配/写入失败等）
 * - interrupted：未完成即退出（如等待确认时关闭应用），下次启动归因
 * - stopped：用户主动停止
 */
export type SyncTaskStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'stopped'

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
  /** 创建时间可读字符串（带年月日）：仅在 createdAtMs 缺失的历史任务中作为展示兜底 */
  createdAt: string
  /**
   * 创建时间的绝对时间戳（Unix 毫秒）：排序与展示的权威依据。
   * 展示层实时按当前系统时区格式化，OS 修改时区后自动按新时区换算；历史任务可能缺失（0）。
   */
  createdAtMs?: number
  /** 0-1，运行中更新 */
  progress: number
  failedDetail: string[]
  /** 逐首处理明细（任务详情清单，旧任务可能为空） */
  detail: SyncItemResult[]
  /** 原始输入清单（同步发起时的 queries）：重新执行时直接复用，旧任务可能为空数组 */
  rawInput: MatchQuery[]
  /** 执行中已创建的目标歌单 ID（adding 阶段检查点）：中断恢复时继续写入剩余批次 */
  playlistId?: string
  /** 发起同步的来源本地歌单 ID（本地歌单 → 平台）：成功后登记反向关联，本地列表点亮平台 logo */
  sourceLocalPlaylistId?: string
}

/**
 * 等待用户手动选择的同步会话（渲染进程状态）。
 * 由 App 层持有：切换视图不卸载，选择面板与已选状态跨视图保留。
 */
export interface PendingConfirmSession {
  /** 主进程待确认会话 id（confirm-sync / cancel-sync 使用） */
  syncTaskId: string
  /** 发起同步时的任务记录快照（取消会话时用于归因） */
  task: SyncTaskRecord
  /** 目标平台 id */
  target: string
  /** 同歌不同作者、待手动选择的候选项 */
  choices: SyncChoice[]
}
