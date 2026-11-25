import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'
import type { PlaylistCacheStore } from './playlistCacheStore'
import { createTokenBucket } from './tokenBucket'
import {
  PLAYLIST_CACHE_SCHEMA_VERSION,
  PLAYLIST_LIST_TTL_MS,
  PLAYLIST_SONGS_TTL_MS,
  REFRESH_BUCKET_CAPACITY,
  REFRESH_BUCKET_REFILL_MS,
} from '@core/cachePolicy'

export interface FetchResult<T> {
  data: T
  /** 数据来自本地缓存（未请求平台） */
  fromCache: boolean
  /** 已返回缓存兜底，后台正在重新验证（更新经 onRefreshed 推送） */
  stale?: boolean
  /** 强制刷新被限流拦截（返回缓存数据）；silent 模式下不标记，静默降级 */
  throttled?: boolean
}

/** 后台重新验证结果：渲染层据 changedIds/addedIds 做行级更新动画 */
export interface RefreshEvent<T> {
  status: 'updated' | 'unchanged' | 'failed'
  /** status=updated 时携带最新全量数据 */
  data?: T
  changedIds?: string[]
  addedIds?: string[]
  removedIds?: string[]
}

interface DiffResult {
  changed: boolean
  changedIds: string[]
  addedIds: string[]
  removedIds: string[]
}

interface ResourceOptions<T> {
  force: boolean
  /** 静默刷新（切回前台/切回页面/打开时自动触发）：限流时不标记 throttled，不打扰用户 */
  silent: boolean
  ttlMs: number
  /** 限流令牌桶 key：列表与歌曲各自独立，短时突发 + 长期总量受控 */
  bucketKey: string
  getCache: () => { data: T; updatedAt: number } | null
  fetch: () => Promise<T>
  save: (data: T) => void
  /** 无变化时仅刷新时间参数 */
  touch: () => void
  /** 新旧数据 diff（行级：changed/added/removed 的 id） */
  diff: (cached: T, fresh: T) => DiffResult
  /** 后台重新验证完成回调（推送给渲染层） */
  onRefreshed: (event: RefreshEvent<T>) => void
}

/**
 * 封面 URL 归一化：忽略协议、CDN 子域轮换（如网易云 p1~p4.music.126.net 随机轮换）
 * 与查询参数（如部分平台签名时间戳），只比较主域名 + 路径。
 * 真正换封面（路径变化）仍会判定为更新。
 */
function normalizeCoverUrl(url?: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    const hostParts = u.hostname.split('.')
    // 主域取最后两段（music.126.net）；IP 或单段域名取原值
    const domain = hostParts.length >= 3 ? hostParts.slice(-2).join('.') : u.hostname
    return `${domain}${u.pathname}`
  } catch {
    return url
  }
}

/** 按 id 逐行 diff：字段变化 → changedIds，新增 → addedIds，删除 → removedIds（顺序变化不触发行动画） */
function diffById<T extends { id: string }>(
  cached: T[],
  fresh: T[],
  fields: (keyof T)[],
  normalize: (field: keyof T, value: unknown) => unknown = (_f, v) => v,
): DiffResult {
  const old = new Map(cached.map((item) => [item.id, item]))
  const changedIds: string[] = []
  const addedIds: string[] = []
  for (const item of fresh) {
    const prev = old.get(item.id)
    if (prev === undefined) {
      addedIds.push(item.id)
    } else if (
      fields.some((f) => normalize(f, prev[f]) !== normalize(f, item[f]))
    ) {
      changedIds.push(item.id)
    }
  }
  const freshIds = new Set(fresh.map((item) => item.id))
  const removedIds = cached.filter((item) => !freshIds.has(item.id)).map((item) => item.id)
  return {
    changed: changedIds.length + addedIds.length + removedIds.length > 0,
    changedIds,
    addedIds,
    removedIds,
  }
}

function normalizePlaylistField(field: keyof PlatformPlaylist, value: unknown): unknown {
  return field === 'coverUrl' ? normalizeCoverUrl(value as string | undefined) : value
}

function normalizeSongField(field: keyof PlatformSong, value: unknown): unknown {
  return field === 'coverUrl' ? normalizeCoverUrl(value as string | undefined) : value
}

const PLAYLIST_FIELDS: (keyof PlatformPlaylist)[] = [
  'name',
  'songCount',
  'coverUrl',
  'webUrl',
  'appUrl',
]
const SONG_FIELDS: (keyof PlatformSong)[] = [
  'title',
  'artist',
  'album',
  'coverUrl',
  'durationMs',
  'genre',
]

/**
 * 歌单缓存服务：缓存永不清空、永远兜底。显示与更新两条线：
 * 读取永远先返回缓存立即展示；缓存过期（TTL）或触发强制刷新（用户手动 /
 * 可见性自动）时后台重新请求接口，逐行 diff：有更新 → 整单替换写入并推送
 * 行级 diff；无更新 → 仅刷新时间参数。
 *
 * 限流采用令牌桶（按列表/歌曲各自独立）：允许短时间连续多次调用，
 * 同时以固定速率补充令牌控制一段时间内的整体调用量。
 * 单飞保证并发请求共享同一次平台请求。
 */
export function createPlaylistCacheService(store: PlaylistCacheStore, now: () => number = Date.now) {
  const flights = new Map<string, Promise<unknown>>()
  const buckets = new Map<string, ReturnType<typeof createTokenBucket>>()

  function bucketFor(key: string) {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = createTokenBucket(REFRESH_BUCKET_CAPACITY, REFRESH_BUCKET_REFILL_MS, now)
      buckets.set(key, bucket)
    }
    return bucket
  }

  /** 后台重新验证：有缓存兜底返回后执行，成功/失败都推送给渲染层 */
  async function revalidateInBackground<T>(
    key: string,
    options: ResourceOptions<T>,
    baseline: T,
  ): Promise<void> {
    if (flights.has(key)) return // 已有在途请求（自动/手动/无缓存拉取共享）
    const promise = (async (): Promise<void> => {
      try {
        const fresh = await options.fetch()
        const diff = options.diff(baseline, fresh)
        if (diff.changed) {
          options.save(fresh)
          options.onRefreshed({ status: 'updated', data: fresh, ...diff })
        } else {
          // 接口返回与缓存一致：不做数据写入，仅刷新时间参数
          options.touch()
          options.onRefreshed({ status: 'unchanged' })
        }
      } catch {
        // 刷新失败：缓存兜底保留
        options.onRefreshed({ status: 'failed' })
      } finally {
        flights.delete(key)
      }
    })()
    flights.set(key, promise)
  }

  async function fetchResource<T>(key: string, options: ResourceOptions<T>): Promise<FetchResult<T>> {
    const cached = options.getCache()
    const fresh = cached !== null && now() - cached.updatedAt < options.ttlMs

    // 缓存新鲜且非强制：直接返回缓存，不请求平台
    if (!options.force && fresh) {
      return { data: cached.data, fromCache: true }
    }

    // 有缓存：先兜底返回，再决定是否后台重新验证（走令牌桶限流）
    if (cached !== null) {
      // 已有在途验证：共享，无需再取令牌
      if (flights.has(key)) {
        return { data: cached.data, fromCache: true, stale: true }
      }
      if (!bucketFor(options.bucketKey).tryTake()) {
        // 令牌不足：静默降级返回缓存；用户显式强刷才标记 throttled（渲染层 toast 提示）
        return {
          data: cached.data,
          fromCache: true,
          throttled: options.force && !options.silent ? true : undefined,
        }
      }
      void revalidateInBackground(key, options, cached.data)
      return { data: cached.data, fromCache: true, stale: true }
    }

    // 无缓存：必须拉取（首次加载不走限流，否则永远看不到数据）；单飞共享在途请求
    const inFlight = flights.get(key)
    if (inFlight !== undefined) {
      return inFlight as Promise<FetchResult<T>>
    }
    const promise = (async (): Promise<FetchResult<T>> => {
      try {
        const data = await options.fetch()
        options.save(data)
        return { data, fromCache: false }
      } finally {
        flights.delete(key)
      }
    })()
    flights.set(key, promise)
    return promise
  }

  return {
    /** 平台歌单列表（force 强制重新验证；silent 静默模式限流时不标记 throttled） */
    playlists(
      platform: string,
      fetchFn: () => Promise<PlatformPlaylist[]>,
      options?: {
        force?: boolean
        silent?: boolean
        onRefreshed?: (event: RefreshEvent<PlatformPlaylist[]>) => void
      },
    ): Promise<FetchResult<PlatformPlaylist[]>> {
      return fetchResource<PlatformPlaylist[]>(`playlists:${platform}`, {
        force: options?.force ?? false,
        silent: options?.silent ?? false,
        ttlMs: PLAYLIST_LIST_TTL_MS,
        bucketKey: `playlists:${platform}`,
        getCache: () => {
          const cached = store.listPlaylists(platform, PLAYLIST_CACHE_SCHEMA_VERSION)
          return cached ? { data: cached.list, updatedAt: cached.updatedAt } : null
        },
        fetch: fetchFn,
        save: (list) => store.savePlaylists(platform, list, now(), PLAYLIST_CACHE_SCHEMA_VERSION),
        touch: () => store.touchPlaylists(platform, now()),
        diff: (cached, fresh) => diffById(cached, fresh, PLAYLIST_FIELDS, normalizePlaylistField),
        onRefreshed: options?.onRefreshed ?? (() => {}),
      })
    },

    /** 歌单歌曲（force 强制重新验证；silent 静默模式限流时不标记 throttled） */
    songs(
      platform: string,
      playlistId: string,
      fetchFn: () => Promise<PlatformSong[]>,
      options?: {
        force?: boolean
        silent?: boolean
        onRefreshed?: (event: RefreshEvent<PlatformSong[]>) => void
      },
    ): Promise<FetchResult<PlatformSong[]>> {
      return fetchResource<PlatformSong[]>(`songs:${platform}:${playlistId}`, {
        force: options?.force ?? false,
        silent: options?.silent ?? false,
        ttlMs: PLAYLIST_SONGS_TTL_MS,
        bucketKey: `songs:${platform}`,
        getCache: () => {
          const cached = store.listSongs(platform, playlistId, PLAYLIST_CACHE_SCHEMA_VERSION)
          return cached ? { data: cached.songs, updatedAt: cached.updatedAt } : null
        },
        fetch: fetchFn,
        save: (songs) =>
          store.saveSongs(platform, playlistId, songs, now(), PLAYLIST_CACHE_SCHEMA_VERSION),
        touch: () => store.touchSongs(platform, playlistId, now()),
        diff: (cached, fresh) => diffById(cached, fresh, SONG_FIELDS, normalizeSongField),
        onRefreshed: options?.onRefreshed ?? (() => {}),
      })
    },
  }
}

export type PlaylistCacheService = ReturnType<typeof createPlaylistCacheService>
