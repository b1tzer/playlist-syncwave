import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createPlaylistCacheStore } from '../../src/main/playlistCacheStore'
import type { PlatformPlaylist } from '@core/models/platform'

const playlist = (id: string, name: string): PlatformPlaylist => ({ id, name, songCount: 1 })
const song = (id: string, title: string, artist: string) => ({ id, title, artist })

describe('playlistCacheStore — 歌单缓存存储', () => {
  let store: ReturnType<typeof createPlaylistCacheStore>

  beforeEach(() => {
    store = createPlaylistCacheStore(new Database(':memory:'))
  })

  it('歌单列表保存后可读回（保持顺序），记录更新时间', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000)
    const cached = store.listPlaylists('netease')
    expect(cached).not.toBeNull()
    expect(cached?.list.map((p) => p.id)).toEqual(['1', '2'])
    expect(cached?.list[0].name).toBe('A')
    expect(cached?.updatedAt).toBe(1000)
  })

  it('保存整份替换：已删除的歌单不再返回', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000)
    store.savePlaylists('netease', [playlist('2', 'B2')], 2000)
    const cached = store.listPlaylists('netease')
    expect(cached?.list).toEqual([playlist('2', 'B2')])
    expect(cached?.updatedAt).toBe(2000)
  })

  it('平台隔离：不同平台缓存互不影响', () => {
    store.savePlaylists('netease', [playlist('1', 'A')], 1000)
    store.savePlaylists('qqmusic', [playlist('9', 'X')], 1000)
    expect(store.listPlaylists('netease')?.list).toHaveLength(1)
    expect(store.listPlaylists('qqmusic')?.list).toHaveLength(1)
  })

  it('无缓存返回 null', () => {
    expect(store.listPlaylists('netease')).toBeNull()
    expect(store.listSongs('netease', '1')).toBeNull()
  })

  it('歌曲保存后可读回（含可选字段与顺序）', () => {
    store.saveSongs(
      'netease',
      '1',
      [
        { id: 'a', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000, coverUrl: 'x', genre: 'pop' },
        song('b', '稻香', '周杰伦'),
      ],
      3000,
    )
    const cached = store.listSongs('netease', '1')
    expect(cached?.updatedAt).toBe(3000)
    expect(cached?.songs).toEqual([
      { id: 'a', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000, coverUrl: 'x', genre: 'pop' },
      song('b', '稻香', '周杰伦'),
    ])
  })

  it('歌曲整单替换：移除的歌曲消失', () => {
    store.saveSongs('netease', '1', [song('a', 'A', 'X'), song('b', 'B', 'X')], 3000)
    store.saveSongs('netease', '1', [song('b', 'B', 'X')], 4000)
    const cached = store.listSongs('netease', '1')
    expect(cached?.songs.map((s) => s.id)).toEqual(['b'])
    expect(cached?.updatedAt).toBe(4000)
  })

  it('歌曲按歌单隔离', () => {
    store.saveSongs('netease', '1', [song('a', 'A', 'X')], 3000)
    store.saveSongs('netease', '2', [song('b', 'B', 'X')], 3000)
    expect(store.listSongs('netease', '1')?.songs.map((s) => s.id)).toEqual(['a'])
    expect(store.listSongs('netease', '2')?.songs.map((s) => s.id)).toEqual(['b'])
  })

  it('失效操作：单歌单 / 单歌单歌曲 / 全平台', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000)
    store.saveSongs('netease', '1', [song('a', 'A', 'X')], 3000)

    store.invalidatePlaylist('netease', '1')
    expect(store.listPlaylists('netease')?.list.map((p) => p.id)).toEqual(['2'])
    expect(store.listSongs('netease', '1')).not.toBeNull()

    store.invalidateSongs('netease', '1')
    expect(store.listSongs('netease', '1')).toBeNull()

    store.invalidatePlaylists('netease')
    expect(store.listPlaylists('netease')).toBeNull()
  })
})
