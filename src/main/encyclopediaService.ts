import type { PlatformAdapter, PlatformEncyclopedia } from '../platforms/base'
import type {
  EncyclopediaCandidate,
  EncyclopediaConfirmRequest,
  EncyclopediaContent,
  EncyclopediaKind,
  EncyclopediaLookupResult,
  EncyclopediaQuery,
} from '@core/models/encyclopedia'
import { createLogger } from '@core/logging'
import { simplify } from '@core/simplify'
import { createTokenBucket, type TokenBucket } from './tokenBucket'
import { LruCache } from './lruCache'
import { withTimeout } from './withTimeout'
import type { EncyclopediaStore } from './encyclopediaStore'

/** 名字归一化：简繁转换 + 小写 + 空白折叠，用于候选打分比较 */
export function normalizeName(raw: string): string {
  return simplify(raw.trim().toLowerCase()).replace(/\s+/g, ' ')
}

export interface RankedCandidate {
  candidate: EncyclopediaCandidate
  score: number
}

/**
 * 候选消歧打分（纯函数，便于单测）。
 *
 * 主信号分级（名字与别名各自取最强一档，互不叠加）：
 *   名字精确 1000 > 别名精确 900 > 前缀 600 > 子串 400
 * 别名精确低于名字精确，避免「名字前缀命中 + 别名精确命中」的错误候选
 * 压过名字精确命中的正确候选。粉丝数对数加成（封顶 20）仅作同档位
 * tie-breaker，总量低于相邻主信号档位差。
 */
export function rankCandidates(
  name: string,
  candidates: EncyclopediaCandidate[],
): RankedCandidate[] {
  const target = normalizeName(name)
  const nameSignal = (raw: string): number => {
    const normalized = normalizeName(raw)
    if (normalized === target) return 1000
    if (normalized.startsWith(target) || target.startsWith(normalized)) return 600
    if (normalized.includes(target) || target.includes(normalized)) return 400
    return 0
  }
  return candidates
    .map((candidate) => {
      let score = nameSignal(candidate.name)
      for (const alias of candidate.aliases ?? []) {
        // 别名信号整体低一档：100 分差保证名字精确候选优先于「前缀+别名精确」候选
        score = Math.max(score, nameSignal(alias) - 100)
      }

      if (candidate.followerCount !== undefined && candidate.followerCount > 0) {
        score += Math.min(20, Math.log10(candidate.followerCount) * 3)
      }
      return { candidate, score }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * 唯一高置信判定：榜首名字精确（1000）或别名精确（900）命中，
 * 且次席未达到别名精确档位（无第二个精确命中）。
 * 榜首 id 必须非空（搜索层可能返回无 id 的残缺条目）。
 * 满足则服务层直接拉详情，否则返回候选列表让用户点选。
 */
export function decideDirect(ranked: RankedCandidate[]): boolean {
  if (ranked.length === 0) return false
  const top = ranked[0]
  if (!top.candidate.id) return false
  const second = ranked[1]
  return top.score >= 900 && (second === undefined || second.score < 900)
}

const LRU_CAPACITY = 200
/** 每平台一个令牌桶：容量 10，每 500ms 补充一枚（低频点击交互足够宽松） */
const BUCKET_CAPACITY = 10
const BUCKET_REFILL_MS = 500

/** 平台接口超时：挂起请求不永久占用单飞槽位、面板不无限转圈 */
const PLATFORM_TIMEOUT_MS = 10_000

/** 缓存键构造（lookup 与失效逻辑同源，格式变更必须改这里） */
function cacheKeyPrefix(platform: string, kind: EncyclopediaKind, name: string): string {
  return `${platform}|${kind}|${normalizeName(name)}|`
}

/** 查询缓存键：forceSearch（换一个）结果独立，避免命中直达路径的缓存 */
function cacheKey(query: EncyclopediaQuery): string {
  return `${cacheKeyPrefix(query.platform, query.kind, query.name)}${query.id ?? ''}|${query.forceSearch ? 'force' : 'normal'}`
}

/** 可缓存结果：仅内容直达与候选列表；限流/异常/无结果的空态不缓存（避免把瞬态失败冻结成永久空态） */
function cacheable(result: EncyclopediaLookupResult): boolean {
  return result.status === 'content' || result.status === 'candidates'
}

/**
 * 主进程实体面板服务：映射缓存 → 搜索 → 消歧打分 → 详情（歌手歌曲/专辑曲目）。
 * 面板是锦上添花的能力：任何一步失败都静默降级，绝不打扰用户。
 */
export function createEncyclopediaService(deps: {
  store: EncyclopediaStore
  resolveAdapter: (platformId: string) => Promise<PlatformAdapter>
  /** 平台登录凭证（酷狗等需要登录态的平台）；未提供视为未登录 */
  getCredential?: (platformId: string) => string | null
  now?: () => number
}) {
  const log = createLogger({ module: 'encyclopedia' })
  const now = deps.now ?? Date.now
  const lru = new LruCache<EncyclopediaLookupResult>(LRU_CAPACITY)
  const flights = new Map<string, Promise<EncyclopediaLookupResult>>()
  const buckets = new Map<string, TokenBucket>()

  function bucketFor(key: string): TokenBucket {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = createTokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_MS, now)
      buckets.set(key, bucket)
    }
    return bucket
  }

  /** 纠偏确认后失效该名字的全部缓存（含 force 键），下一次查询走新映射直达 */
  function invalidateName(platform: string, kind: EncyclopediaKind, name: string): void {
    const prefix = cacheKeyPrefix(platform, kind, name)
    for (const key of lru.keys()) {
      if (key.startsWith(prefix)) lru.delete(key)
    }
  }

  /**
   * 专辑直达 id 按平台选取详情接口所需形态：
   * QQ 详情接口只吃 albummid，网易等其余平台用数字 id。
   */
  function resolveEntityId(
    query: EncyclopediaQuery,
    mapping: { entityId: string } | null,
  ): string | undefined {
    if (mapping) return mapping.entityId
    if (query.kind === 'singer') return query.id
    if (query.platform === 'qqmusic') return query.albumMid ?? query.albumId
    return query.albumId ?? query.albumMid
  }

  /** 拉面板内容（歌手歌曲/专辑曲目）；失败静默返回 null */
  async function fetchContent(
    encyclopedia: PlatformEncyclopedia,
    kind: EncyclopediaKind,
    id: string,
    name: string,
    credential?: string,
  ): Promise<EncyclopediaContent | null> {
    try {
      return await withTimeout(
        encyclopedia.detail(kind, id, name, credential),
        PLATFORM_TIMEOUT_MS,
      )
    } catch {
      return null
    }
  }

  async function doLookup(query: EncyclopediaQuery): Promise<EncyclopediaLookupResult> {
    const adapter = await deps.resolveAdapter(query.platform)
    const encyclopedia = adapter.encyclopedia
    if (!encyclopedia) return { status: 'unsupported' }

    // 登录凭证始终注入（有登录态传登录 cookie；酷狗未登录时也带设备指纹调用）
    const credential = deps.getCredential?.(query.platform) ?? undefined

    if (!bucketFor(query.platform).tryTake()) {
      log.warn('encyclopedia.lookup', '触发限流，静默降级为空态', {
        platform: query.platform,
        kind: query.kind,
      })
      return { status: 'empty' }
    }

    try {
      // 1. 纠偏映射（用户点选过的「名字 → id」）与请求自带 id 优先直达；
      //    「换一个」强制重新搜索时跳过本步
      const mapping =
        !query.forceSearch && query.id === undefined
          ? deps.store.find(query.platform, query.kind, query.name)
          : null
      const directId =
        query.forceSearch
          ? undefined
          : (query.id ?? resolveEntityId(query, mapping))
      if (directId) {
        const content = await fetchContent(encyclopedia, query.kind, directId, query.name, credential)
        if (content) return { status: 'content', content }
        // id 已失效（如平台清理数据）：清掉映射后走名字搜索
        if (mapping) deps.store.remove(query.platform, query.kind, query.name)
      }

      // 2. 名字搜索 + 消歧打分
      const candidates = await withTimeout(
        encyclopedia.search(query.kind, query.name, credential),
        PLATFORM_TIMEOUT_MS,
      )
      if (candidates.length === 0) return { status: 'empty' }
      const ranked = rankCandidates(query.name, candidates)
      if (decideDirect(ranked)) {
        const content = await fetchContent(
          encyclopedia,
          query.kind,
          ranked[0].candidate.id,
          query.name,
          credential,
        )
        if (content) return { status: 'content', content }
        // 详情失败：退回候选列表让用户手动点选
      }
      // 过滤无 id 的残缺候选（不可点选确认）
      const valid = ranked.filter((r) => r.candidate.id !== '')
      return { status: 'candidates', candidates: valid.map((r) => r.candidate).slice(0, 10) }
    } catch (e) {
      log.warn('encyclopedia.lookup', '查询失败，静默降级为空态', {
        platform: query.platform,
        kind: query.kind,
        name: query.name,
        message: e instanceof Error ? e.message : String(e),
      })
      return { status: 'empty' }
    }
  }

  async function lookup(query: EncyclopediaQuery): Promise<EncyclopediaLookupResult> {
    const key = cacheKey(query)
    const cached = lru.get(key)
    if (cached !== undefined) return cached
    // 单飞：并发同键查询共享同一次请求
    const inFlight = flights.get(key)
    if (inFlight) return inFlight
    const promise = doLookup(query)
    flights.set(key, promise)
    try {
      const result = await promise
      // 只有内容/候选结果进缓存：限流空态、异常空态不冻结，用户稍后重试仍能成功
      if (cacheable(result)) lru.set(key, result)
      return result
    } finally {
      flights.delete(key)
    }
  }

  function confirm(req: EncyclopediaConfirmRequest): void {
    deps.store.save(req.platform, req.kind, req.name, req.entityId, req.entityName)
    invalidateName(req.platform, req.kind, req.name)
    log.debug('encyclopedia.confirm', '已记录纠偏映射', {
      platform: req.platform,
      kind: req.kind,
      name: req.name,
      entityId: req.entityId,
    })
  }

  return { lookup, confirm }
}
