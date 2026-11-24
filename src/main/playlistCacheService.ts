import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'
import type { PlaylistCacheStore } from './playlistCacheStore'
import {
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  PLAYLIST_LIST_TTL_MS,
  PLAYLIST_SONGS_TTL_MS,
} from '@core/cachePolicy'

export interface FetchResult<T> {
  data: T
  /** 数据来自本地缓存（未请求平台） */
  fromCache: boolean
  /** 手动强制刷新被限流拦截（返回缓存数据） */
  throttled?: boolean
}

interface ResourceOptions<T> {
  force: boolean
  ttlMs: number
  minIntervalMs: number
  getCache: () => { data: T; updatedAt: number } | null
  fetch: () => Promise<T>
  save: (data: T) => void
}

/**
 * 歌单缓存服务：缓存优先 + TTL 自动刷新 + 单飞去重 + 手动刷新限流。
 * 单飞保证自动刷新（TTL 过期）与手动刷新并发时共享同一次平台请求。
 */
export function createPlaylistCacheService(store: PlaylistCacheStore, now: () => number = Date.now) {
  const flights = new Map<string, Promise<unknown>>()
  const lastSuccess = new Map<string, number>()

  async function fetchResource<T>(key: string, options: ResourceOptions<T>): Promise<FetchResult<T>> {
    const cached = options.getCache()
    const fresh = cached !== null && now() - cached.updatedAt < options.ttlMs

    if (!options.force && fresh) {
      return { data: cached.data, fromCache: true }
    }

    // 手动强制刷新限流：上次成功拉取距今不足阈值且有缓存可展示 → 返回缓存并标记
    const last = lastSuccess.get(key) ?? 0
    if (options.force && cached !== null && now() - last < options.minIntervalMs) {
      return { data: cached.data, fromCache: true, throttled: true }
    }

    // 单飞：同一资源并发只发一次平台请求（自动/手动冲突时共享在途请求）
    const inFlight = flights.get(key)
    if (inFlight !== undefined) {
      return inFlight as Promise<FetchResult<T>>
    }

    const promise = (async (): Promise<FetchResult<T>> => {
      try {
        const data = await options.fetch()
        options.save(data)
        lastSuccess.set(key, now())
        return { data, fromCache: false }
      } finally {
        flights.delete(key)
      }
    })()
    flights.set(key, promise)
    return promise
  }

  return {
    /** 平台歌单列表（force 为手动强制刷新） */
    playlists(
      platform: string,
      fetchFn: () => Promise<PlatformPlaylist[]>,
      options?: { force?: boolean },
    ): Promise<FetchResult<PlatformPlaylist[]>> {
      return fetchResource<PlatformPlaylist[]>(`playlists:${platform}`, {
        force: options?.force ?? false,
        ttlMs: PLAYLIST_LIST_TTL_MS,
        minIntervalMs: MANUAL_REFRESH_MIN_INTERVAL_MS,
        getCache: () => {
          const cached = store.listPlaylists(platform)
          return cached ? { data: cached.list, updatedAt: cached.updatedAt } : null
        },
        fetch: fetchFn,
        save: (list) => store.savePlaylists(platform, list, now()),
      })
    },

    /** 歌单歌曲（force 为手动强制刷新） */
    songs(
      platform: string,
      playlistId: string,
      fetchFn: () => Promise<PlatformSong[]>,
      options?: { force?: boolean },
    ): Promise<FetchResult<PlatformSong[]>> {
      return fetchResource<PlatformSong[]>(`songs:${platform}:${playlistId}`, {
        force: options?.force ?? false,
        ttlMs: PLAYLIST_SONGS_TTL_MS,
        minIntervalMs: MANUAL_REFRESH_MIN_INTERVAL_MS,
        getCache: () => {
          const cached = store.listSongs(platform, playlistId)
          return cached ? { data: cached.songs, updatedAt: cached.updatedAt } : null
        },
        fetch: fetchFn,
        save: (songs) => store.saveSongs(platform, playlistId, songs, now()),
      })
    },
  }
}

export type PlaylistCacheService = ReturnType<typeof createPlaylistCacheService>
