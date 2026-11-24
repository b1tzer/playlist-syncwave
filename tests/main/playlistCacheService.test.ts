import { describe, it, expect, vi } from 'vitest'
import { createPlaylistCacheService } from '../../src/main/playlistCacheService'
import type { PlaylistCacheStore } from '../../src/main/playlistCacheStore'
import {
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  PLAYLIST_LIST_TTL_MS,
  PLAYLIST_SONGS_TTL_MS,
} from '../../src/core/cachePolicy'
import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'

const sampleList = (): PlatformPlaylist[] => [{ id: '1', name: 'A', songCount: 1 }]
const sampleSongs = (): PlatformSong[] => [{ id: 's1', title: 'T', artist: 'A' }]

function makeHarness() {
  let clock = 1_000_000
  const listCache = new Map<string, { list: PlatformPlaylist[]; updatedAt: number }>()
  const songsCache = new Map<string, { songs: PlatformSong[]; updatedAt: number }>()

  const store = {
    listPlaylists: (platform: string) => listCache.get(platform) ?? null,
    savePlaylists: (platform: string, list: PlatformPlaylist[], updatedAt: number) => {
      listCache.set(platform, { list, updatedAt })
    },
    invalidatePlaylists: (platform: string) => {
      listCache.delete(platform)
    },
    invalidatePlaylist: (platform: string, playlistId: string) => {
      const cached = listCache.get(platform)
      if (!cached) return
      cached.list = cached.list.filter((p) => p.id !== playlistId)
    },
    listSongs: (platform: string, playlistId: string) =>
      songsCache.get(`${platform}:${playlistId}`) ?? null,
    saveSongs: (platform: string, playlistId: string, songs: PlatformSong[], updatedAt: number) => {
      songsCache.set(`${platform}:${playlistId}`, { songs, updatedAt })
    },
    invalidateSongs: (platform: string, playlistId: string) => {
      songsCache.delete(`${platform}:${playlistId}`)
    },
  } as PlaylistCacheStore

  const service = createPlaylistCacheService(store, () => clock)
  return {
    service,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('playlistCacheService — TTL 自动刷新 / 单飞 / 手动刷新限流', () => {
  it('新鲜缓存直接返回，不请求平台', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const again = await h.service.playlists('netease', fetchFn)
    expect(again.fromCache).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后自动刷新并保存（歌曲缓存 TTL 独立生效）', async () => {
    const h = makeHarness()
    const fetchList = vi.fn(async () => sampleList())
    const fetchSongs = vi.fn(async () => sampleSongs())
    await h.service.playlists('netease', fetchList)
    await h.service.songs('netease', '1', fetchSongs)

    // 列表过期、歌曲未过期：仅列表重新请求
    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    const listResult = await h.service.playlists('netease', fetchList)
    expect(listResult.fromCache).toBe(false)
    expect(fetchList).toHaveBeenCalledTimes(2)
    const songsResult = await h.service.songs('netease', '1', fetchSongs)
    expect(songsResult.fromCache).toBe(true)
    expect(fetchSongs).toHaveBeenCalledTimes(1)

    // 歌曲过期：重新请求
    h.advance(PLAYLIST_SONGS_TTL_MS)
    const songsRefreshed = await h.service.songs('netease', '1', fetchSongs)
    expect(songsRefreshed.fromCache).toBe(false)
    expect(fetchSongs).toHaveBeenCalledTimes(2)
  })

  it('手动强制刷新在最小间隔内 → throttled 返回缓存，不请求平台', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)
    h.advance(5000)
    const result = await h.service.playlists('netease', fetchFn, { force: true })
    expect(result.throttled).toBe(true)
    expect(result.fromCache).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('手动强制刷新超过最小间隔 → 重新请求', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)
    h.advance(MANUAL_REFRESH_MIN_INTERVAL_MS + 1)
    const result = await h.service.playlists('netease', fetchFn, { force: true })
    expect(result.throttled).toBeUndefined()
    expect(result.fromCache).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('无缓存时强制刷新不受限流（首次手动刷新直接拉取）', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    const result = await h.service.playlists('netease', fetchFn, { force: true })
    expect(result.throttled).toBeUndefined()
    expect(result.fromCache).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('并发请求单飞去重：同一资源只发一次平台请求（自动与手动冲突时共享）', async () => {
    const h = makeHarness()
    let resolveFetch: (v: PlatformPlaylist[]) => void = () => {}
    const fetchFn = vi.fn(
      () => new Promise<PlatformPlaylist[]>((resolve) => (resolveFetch = resolve)),
    )
    const auto = h.service.playlists('netease', fetchFn)
    const manual = h.service.playlists('netease', fetchFn, { force: true })
    resolveFetch(sampleList())
    const [a, b] = await Promise.all([auto, manual])
    expect(a.data).toHaveLength(1)
    expect(b.data).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('拉取失败不记 lastSuccess、不写缓存，可立即重试', async () => {
    const h = makeHarness()
    const fetchFn = vi
      .fn<() => Promise<PlatformPlaylist[]>>()
      .mockResolvedValueOnce(sampleList())
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(sampleList())
    await h.service.playlists('netease', fetchFn)

    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    await expect(h.service.playlists('netease', fetchFn)).rejects.toThrow('网络错误')
    expect(fetchFn).toHaveBeenCalledTimes(2)

    // 失败未更新 lastSuccess（上次成功已超阈值），立即强制刷新应放行
    const retry = await h.service.playlists('netease', fetchFn, { force: true })
    expect(retry.throttled).toBeUndefined()
    expect(retry.fromCache).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('歌曲缓存按歌单隔离，互不串扰', async () => {
    const h = makeHarness()
    const fetchSongs = vi.fn(async (playlistId: string) => [{ id: `s-${playlistId}`, title: 'T', artist: 'A' }])
    await h.service.songs('netease', '1', () => fetchSongs('1'))
    await h.service.songs('netease', '2', () => fetchSongs('2'))
    expect(fetchSongs).toHaveBeenCalledTimes(2)

    const again = await h.service.songs('netease', '1', () => fetchSongs('1'))
    expect(again.fromCache).toBe(true)
    expect(again.data[0].id).toBe('s-1')
    expect(fetchSongs).toHaveBeenCalledTimes(2)
  })

  it('不同资源并发互不阻塞：两个歌单同时各拉一次', async () => {
    const h = makeHarness()
    const fetchSongs = vi.fn(async (playlistId: string) => [{ id: playlistId, title: 'T', artist: 'A' }])
    const [a, b] = await Promise.all([
      h.service.songs('netease', '1', () => fetchSongs('1')),
      h.service.songs('netease', '2', () => fetchSongs('2')),
    ])
    expect(a.data[0].id).toBe('1')
    expect(b.data[0].id).toBe('2')
    expect(fetchSongs).toHaveBeenCalledTimes(2)
  })
})
