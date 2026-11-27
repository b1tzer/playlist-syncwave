import type { PlatformAdapter } from '../platforms/base'
import type {
  SongDetailData,
  SongDetailRequest,
} from '@core/models/songDetail'
import { createLogger } from '@core/logging'
import { createTokenBucket } from './tokenBucket'
import { LruCache } from './lruCache'

/** 容量 10、500ms 补 1：点击触发场景足够，同时约束平台接口压力 */
const BUCKET_CAPACITY = 10
const BUCKET_REFILL_MS = 500

/** 简单 LRU（平台接口点击频度低，容量 200 足够覆盖常用歌曲） */
const LRU_CAPACITY = 200

/** 缓存键唯一构造点：主 id + 次级标识共同定位（QQ 歌词依赖 songMid、发行时间依赖 albumMid） */
function cacheKey(request: SongDetailRequest): string {
  const ids = request.identifiers ?? {}
  return `${request.platform}|${request.songId}|${ids.songMid ?? ''}|${ids.albumMid ?? ''}|${ids.albumId ?? ''}`
}

export type SongDetailService = ReturnType<typeof createSongDetailService>

/**
 * 歌曲详情补充服务：歌词/发行时间/平台跳转。
 * 与百科服务分开：请求失败静默返回 null（渲染层保持本地身份信息），
 * 绝不把歌词这类非关键补充做成打扰用户的错误弹窗。
 * 失败/限流结果不进缓存：瞬态失败不冻结，稍后重试仍会真正请求平台。
 */
export function createSongDetailService(deps: {
  resolveAdapter: (platformId: string) => Promise<PlatformAdapter>
  now?: () => number
}) {
  const log = createLogger({ module: 'main.song-detail' })
  const lru = new LruCache<SongDetailData | null>(LRU_CAPACITY)
  const bucket = createTokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_MS, deps.now)
  const flights = new Map<string, Promise<SongDetailData | null>>()

  async function lookup(request: SongDetailRequest): Promise<SongDetailData | null> {
    const key = cacheKey(request)
    const cached = lru.get(key)
    if (cached !== undefined) return cached

    const inflight = flights.get(key)
    if (inflight) return inflight

    const task = doLookup(request, key).finally(() => flights.delete(key))
    flights.set(key, task)
    return task
  }

  async function doLookup(
    request: SongDetailRequest,
    key: string,
  ): Promise<SongDetailData | null> {
    // 限流直接空手返回，不进缓存（下次点击重试）
    if (!bucket.tryTake()) return null
    try {
      const adapter = await deps.resolveAdapter(request.platform)
      if (!adapter.songDetail) return null
      const result = await adapter.songDetail.detail(request.songId, request.identifiers ?? {}, {
        title: request.title,
        artist: request.artist,
      })
      lru.set(key, result)
      return result
    } catch (e) {
      log.warn('song-detail.lookup', '歌曲详情获取失败（静默降级）', {
        platform: request.platform,
        songId: request.songId,
        message: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }

  return { lookup }
}
