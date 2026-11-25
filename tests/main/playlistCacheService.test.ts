import { describe, it, expect, vi } from 'vitest'
import { createPlaylistCacheService } from '../../src/main/playlistCacheService'
import type { PlaylistCacheStore } from '../../src/main/playlistCacheStore'
import {
  PLAYLIST_LIST_TTL_MS,
  PLAYLIST_SONGS_TTL_MS,
  REFRESH_BUCKET_CAPACITY,
  REFRESH_BUCKET_REFILL_MS,
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
    touchPlaylists: (platform: string, updatedAt: number) => {
      const cached = listCache.get(platform)
      if (cached) cached.updatedAt = updatedAt
    },
    listSongs: (platform: string, playlistId: string) =>
      songsCache.get(`${platform}:${playlistId}`) ?? null,
    saveSongs: (platform: string, playlistId: string, songs: PlatformSong[], updatedAt: number) => {
      songsCache.set(`${platform}:${playlistId}`, { songs, updatedAt })
    },
    touchSongs: (platform: string, playlistId: string, updatedAt: number) => {
      const cached = songsCache.get(`${platform}:${playlistId}`)
      if (cached) cached.updatedAt = updatedAt
    },
  } as unknown as PlaylistCacheStore

  const service = createPlaylistCacheService(store, () => clock)
  return {
    service,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('playlistCacheService — 缓存兜底 + 后台重新验证（SWR）/ 令牌桶限流 / 单飞', () => {
  it('新鲜缓存直接返回，不请求平台', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const again = await h.service.playlists('netease', fetchFn)
    expect(again.fromCache).toBe(true)
    expect(again.stale).toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期：立即返回缓存兜底（stale），后台重新验证有变化 → 整单替换写入并推送行级 diff', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)

    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    const changed = [
      { id: '1', name: 'A2', songCount: 2 },
      { id: '2', name: 'B', songCount: 1 },
    ]
    fetchFn.mockResolvedValueOnce(changed)
    const refreshed = vi.fn()
    const result = await h.service.playlists('netease', fetchFn, { onRefreshed: refreshed })

    // 立即返回旧缓存兜底，不等待平台
    expect(result.fromCache).toBe(true)
    expect(result.stale).toBe(true)
    expect(result.data).toEqual(sampleList())

    // 后台重新验证完成：有更新 → 写入并推送 diff（changed 行 + added 行）
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1))
    expect(refreshed).toHaveBeenCalledWith({
      status: 'updated',
      data: changed,
      changed: true,
      changedIds: ['1'],
      addedIds: ['2'],
      removedIds: [],
    })

    // 缓存已更新：TTL 内再次读取拿到新数据
    const again = await h.service.playlists('netease', fetchFn)
    expect(again.fromCache).toBe(true)
    expect(again.stale).toBeUndefined()
    expect(again.data).toEqual(changed)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('后台重新验证无变化：不写数据，仅刷新时间参数并推送 unchanged', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)

    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    const refreshed = vi.fn()
    const result = await h.service.playlists('netease', fetchFn, { onRefreshed: refreshed })
    expect(result.stale).toBe(true)

    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith({ status: 'unchanged' }))
    // 时间参数已刷新：立即再次读取不再触发后台（fetch 仍是 2 次）
    const again = await h.service.playlists('netease', fetchFn)
    expect(again.stale).toBeUndefined()
    expect(again.data).toEqual(sampleList())
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('封面 URL 仅 CDN 子域轮换不视为变化（不变数据、不动画），路径变化才更新', async () => {
    const h = makeHarness()
    const withCover = (url: string): PlatformSong[] => [
      { id: 's1', title: 'T', artist: 'A', coverUrl: url },
    ]
    const fetchFn = vi.fn(async () => withCover('http://p3.music.126.net/abc.jpg'))
    await h.service.songs('netease', '1', fetchFn)

    // 子域轮换 + 查询参数变化：归一化后一致 → unchanged（touch 时间参数，不写数据）
    fetchFn.mockResolvedValueOnce(withCover('http://p4.music.126.net/abc.jpg?param=200y200'))
    h.advance(PLAYLIST_SONGS_TTL_MS + 1)
    const refreshed = vi.fn()
    const result = await h.service.songs('netease', '1', fetchFn, { onRefreshed: refreshed })
    expect(result.stale).toBe(true)
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith({ status: 'unchanged' }))

    // 路径真实变化（换封面）：判定更新并推送行级 diff
    fetchFn.mockResolvedValueOnce(withCover('http://p3.music.126.net/xyz.jpg'))
    h.advance(PLAYLIST_SONGS_TTL_MS + 1)
    await h.service.songs('netease', '1', fetchFn, { onRefreshed: refreshed })
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(2))
    expect(refreshed).toHaveBeenLastCalledWith({
      status: 'updated',
      data: withCover('http://p3.music.126.net/xyz.jpg'),
      changed: true,
      changedIds: ['s1'],
      addedIds: [],
      removedIds: [],
    })
  })

  it('歌单列表封面 URL 子域轮换同样不视为变化', async () => {
    const h = makeHarness()
    const withCover = (url: string): PlatformPlaylist[] => [
      { id: '1', name: 'A', songCount: 1, coverUrl: url },
    ]
    const fetchFn = vi.fn(async () => withCover('http://p3.music.126.net/abc.jpg'))
    await h.service.playlists('netease', fetchFn)

    fetchFn.mockResolvedValueOnce(withCover('http://p4.music.126.net/abc.jpg'))
    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    const refreshed = vi.fn()
    await h.service.playlists('netease', fetchFn, { onRefreshed: refreshed })
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith({ status: 'unchanged' }))
  })

  it('后台重新验证失败：推送 failed，缓存保留兜底', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)

    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    fetchFn.mockRejectedValueOnce(new Error('网络错误'))
    const refreshed = vi.fn()
    const result = await h.service.playlists('netease', fetchFn, { onRefreshed: refreshed })

    expect(result.fromCache).toBe(true)
    expect(result.data).toEqual(sampleList())

    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith({ status: 'failed' }))
    // 缓存仍可用
    const again = await h.service.playlists('netease', fetchFn)
    expect(again.fromCache).toBe(true)
    expect(again.data[0].id).toBe('1')
  })

  it('歌曲缓存 TTL 独立生效：歌曲过期返回缓存兜底并后台重新验证', async () => {
    const h = makeHarness()
    const fetchList = vi.fn(async () => sampleList())
    const fetchSongs = vi.fn(async () => sampleSongs())
    await h.service.playlists('netease', fetchList)
    await h.service.songs('netease', '1', fetchSongs)

    h.advance(PLAYLIST_LIST_TTL_MS + 1)
    const listResult = await h.service.playlists('netease', fetchList)
    expect(listResult.stale).toBe(true)
    await vi.waitFor(() => expect(fetchList).toHaveBeenCalledTimes(2))
    const songsResult = await h.service.songs('netease', '1', fetchSongs)
    expect(songsResult.fromCache).toBe(true)
    expect(songsResult.stale).toBeUndefined()
    expect(fetchSongs).toHaveBeenCalledTimes(1)

    h.advance(PLAYLIST_SONGS_TTL_MS)
    const songsStale = await h.service.songs('netease', '1', fetchSongs)
    expect(songsStale.fromCache).toBe(true)
    expect(songsStale.stale).toBe(true)
    await vi.waitFor(() => expect(fetchSongs).toHaveBeenCalledTimes(2))
  })

  it('令牌桶：允许短时间连续强制刷新（容量内），超出后 throttled 返回缓存', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    // 无缓存首拉不消耗令牌
    await h.service.playlists('netease', fetchFn)

    for (let i = 0; i < REFRESH_BUCKET_CAPACITY; i++) {
      const r = await h.service.playlists('netease', fetchFn, { force: true })
      expect(r.throttled).toBeUndefined()
      expect(r.stale).toBe(true)
    }
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1 + REFRESH_BUCKET_CAPACITY))

    // 桶空：强制刷新被限流，返回缓存并标记 throttled（非 silent）
    const throttled = await h.service.playlists('netease', fetchFn, { force: true })
    expect(throttled.throttled).toBe(true)
    expect(throttled.fromCache).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1 + REFRESH_BUCKET_CAPACITY)
  })

  it('令牌桶按速率补充：等待一个补充周期后恢复一次调用额度', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)
    for (let i = 0; i < REFRESH_BUCKET_CAPACITY; i++) {
      await h.service.playlists('netease', fetchFn, { force: true, silent: true })
    }
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1 + REFRESH_BUCKET_CAPACITY))

    // 立即强刷：限流
    expect((await h.service.playlists('netease', fetchFn, { force: true })).throttled).toBe(true)

    // 推进一个补充周期：恢复 1 个令牌，可再请求一次
    h.advance(REFRESH_BUCKET_REFILL_MS)
    const ok = await h.service.playlists('netease', fetchFn, { force: true, silent: true })
    expect(ok.throttled).toBeUndefined()

    // 再次立即强刷：令牌耗尽又被限流
    expect((await h.service.playlists('netease', fetchFn, { force: true })).throttled).toBe(true)
  })

  it('silent 模式限流时不标记 throttled（可见性自动刷新静默降级）', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    await h.service.playlists('netease', fetchFn)
    for (let i = 0; i < REFRESH_BUCKET_CAPACITY; i++) {
      await h.service.playlists('netease', fetchFn, { force: true, silent: true })
    }

    // silent：限流静默返回缓存，不标记（渲染层不弹 toast）
    const silent = await h.service.playlists('netease', fetchFn, { force: true, silent: true })
    expect(silent.throttled).toBeUndefined()
    expect(silent.fromCache).toBe(true)

    // 非 silent：标记 throttled
    expect((await h.service.playlists('netease', fetchFn, { force: true })).throttled).toBe(true)
  })

  it('列表与歌曲各自独立限流桶，互不挤占', async () => {
    const h = makeHarness()
    const fetchList = vi.fn(async () => sampleList())
    const fetchSongs = vi.fn(async () => sampleSongs())
    await h.service.playlists('netease', fetchList)
    await h.service.songs('netease', '1', fetchSongs)

    // 列表耗尽令牌
    for (let i = 0; i < REFRESH_BUCKET_CAPACITY; i++) {
      await h.service.playlists('netease', fetchList, { force: true, silent: true })
    }
    expect((await h.service.playlists('netease', fetchList, { force: true })).throttled).toBe(true)

    // 歌曲桶不受列表影响，仍可强制刷新
    const songs = await h.service.songs('netease', '1', fetchSongs, { force: true })
    expect(songs.throttled).toBeUndefined()
  })

  it('无缓存强制刷新不受限流（首次拉取直接放行）', async () => {
    const h = makeHarness()
    const fetchFn = vi.fn(async () => sampleList())
    const result = await h.service.playlists('netease', fetchFn, { force: true })
    expect(result.throttled).toBeUndefined()
    expect(result.fromCache).toBe(false)
    expect(result.stale).toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('无缓存并发请求单飞去重：同一资源只发一次平台请求（自动与手动冲突时共享）', async () => {
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

  it('无缓存拉取失败向上抛出（无兜底），可立即重试', async () => {
    const h = makeHarness()
    const fetchFn = vi
      .fn<() => Promise<PlatformPlaylist[]>>()
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(sampleList())
    await expect(h.service.playlists('netease', fetchFn)).rejects.toThrow('网络错误')
    const retry = await h.service.playlists('netease', fetchFn, { force: true })
    expect(retry.throttled).toBeUndefined()
    expect(retry.fromCache).toBe(false)
    expect(retry.data).toEqual(sampleList())
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('歌曲缓存按歌单隔离，互不串扰', async () => {
    const h = makeHarness()
    const fetchSongs = vi.fn(async (playlistId: string) => [
      { id: `s-${playlistId}`, title: 'T', artist: 'A' },
    ])
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
    const fetchSongs = vi.fn(async (playlistId: string) => [
      { id: playlistId, title: 'T', artist: 'A' },
    ])
    const [a, b] = await Promise.all([
      h.service.songs('netease', '1', () => fetchSongs('1')),
      h.service.songs('netease', '2', () => fetchSongs('2')),
    ])
    expect(a.data[0].id).toBe('1')
    expect(b.data[0].id).toBe('2')
    expect(fetchSongs).toHaveBeenCalledTimes(2)
  })
})
