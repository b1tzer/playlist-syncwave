import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createPlaylistCacheStore } from '../../src/main/playlistCacheStore'
import type { PlatformPlaylist } from '@core/models/platform'

const playlist = (id: string, name: string): PlatformPlaylist => ({ id, name, songCount: 1 })
const song = (id: string, title: string, artist: string) => ({ id, title, artist })

describe('playlistCacheStore — 歌单缓存存储（缓存永不清空，失效仅标记过期）', () => {
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

  it('平台未提供歌曲数：songCount 缺省时存 NULL，读回为 undefined', () => {
    store.savePlaylists('applemusic', [{ id: 'p.1', name: '歌单' }], 1000)
    const cached = store.listPlaylists('applemusic')
    expect(cached?.list).toHaveLength(1)
    expect(cached?.list[0].songCount).toBeUndefined()
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

  it('标记过期：数据保留兜底，updatedAt 归 0（列表/歌曲）', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000)
    store.saveSongs('netease', '1', [song('a', 'A', 'X')], 3000)

    store.markStalePlaylists('netease')
    const staleList = store.listPlaylists('netease')
    expect(staleList?.list.map((p) => p.id)).toEqual(['1', '2'])
    expect(staleList?.updatedAt).toBe(0)

    store.markStaleSongs('netease', '1')
    const staleSongs = store.listSongs('netease', '1')
    expect(staleSongs?.songs.map((s) => s.id)).toEqual(['a'])
    expect(staleSongs?.updatedAt).toBe(0)
  })

  it('touch：接口无变化时仅刷新时间参数，数据不变', () => {
    store.savePlaylists('netease', [playlist('1', 'A')], 1000)
    store.saveSongs('netease', '1', [song('a', 'A', 'X')], 3000)

    store.touchPlaylists('netease', 5000)
    store.touchSongs('netease', '1', 6000)

    const list = store.listPlaylists('netease')
    expect(list?.list.map((p) => p.id)).toEqual(['1'])
    expect(list?.updatedAt).toBe(5000)
    const songs = store.listSongs('netease', '1')
    expect(songs?.songs.map((s) => s.id)).toEqual(['a'])
    expect(songs?.updatedAt).toBe(6000)
  })

  it('重命名后就地更新缓存行名称，其他行不受影响', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000)
    store.updatePlaylistName('netease', '1', 'A2')
    const cached = store.listPlaylists('netease')
    expect(cached?.list).toEqual([playlist('1', 'A2'), playlist('2', 'B')])
  })

  it('删除歌单后同步移除缓存行（业务数据变更）', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000)
    store.removePlaylist('netease', '1')
    const cached = store.listPlaylists('netease')
    expect(cached?.list.map((p) => p.id)).toEqual(['2'])
  })

  it('schema 版本不匹配：旧数据不清空仍兜底返回，updatedAt 归 0 视为过期', () => {
    store.savePlaylists('kugou', [playlist('1', 'A')], 1000)
    store.saveSongs('kugou', '1', [song('a', 'A', 'X')], 1000)
    // 旧数据无版本记录：带版本读取仍返回数据（兜底），但 updatedAt=0（过期，立即后台重新验证）
    const list = store.listPlaylists('kugou', 2)
    expect(list?.list.map((p) => p.id)).toEqual(['1'])
    expect(list?.updatedAt).toBe(0)
    const songs = store.listSongs('kugou', '1', 2)
    expect(songs?.songs.map((s) => s.id)).toEqual(['a'])
    expect(songs?.updatedAt).toBe(0)
    // 数据未被清空：无版本参数读取仍有数据
    expect(store.listPlaylists('kugou')?.list).toHaveLength(1)
    expect(store.listSongs('kugou', '1')?.songs).toHaveLength(1)

    // 写入版本后按版本读回正常
    store.savePlaylists('kugou', [playlist('1', 'A')], 2000, 2)
    store.saveSongs('kugou', '1', [song('a', 'A', 'X')], 3000, 2)
    expect(store.listPlaylists('kugou', 2)?.updatedAt).toBe(2000)
    expect(store.listSongs('kugou', '1', 2)?.updatedAt).toBe(3000)
  })

  it('schema 版本按平台隔离：其他平台写入版本不误认本平台旧缓存', () => {
    // kugou 旧数据(无版本)
    store.savePlaylists('kugou', [playlist('1', 'A')], 1000)
    // 其他平台以版本 2 写入
    store.savePlaylists('netease', [playlist('2', 'B')], 2000, 2)
    // kugou 旧缓存兜底返回但视为过期（updatedAt=0）
    expect(store.listPlaylists('kugou', 2)?.updatedAt).toBe(0)
    // netease 版本匹配正常
    expect(store.listPlaylists('netease', 2)?.updatedAt).toBe(2000)
  })

  it('clearAll：物理清空全部缓存与版本记录（危险区操作），返回删除行数', () => {
    store.savePlaylists('netease', [playlist('1', 'A'), playlist('2', 'B')], 1000, 5)
    store.savePlaylists('qqmusic', [playlist('9', 'X')], 1000, 5)
    store.saveSongs('netease', '1', [song('a', 'A', 'X'), song('b', 'B', 'X')], 3000, 5)

    const { playlists, songs } = store.clearAll()

    expect(playlists).toBe(3)
    expect(songs).toBe(2)
    // 数据物理删除：无版本参数读取也为 null（与 markStale 的兜底语义不同）
    expect(store.listPlaylists('netease')).toBeNull()
    expect(store.listPlaylists('qqmusic')).toBeNull()
    expect(store.listSongs('netease', '1')).toBeNull()
  })
})
