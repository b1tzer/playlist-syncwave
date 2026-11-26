import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  store: null as unknown,
  cacheList: [] as Array<{ id: string; coverUrl?: string }>,
  cacheSongs: [] as Array<{ id: string; coverUrl?: string }>,
}))

vi.mock('../../src/main/appDatabase', () => ({
  getDatabase: () => ({
    localPlaylists: state.store,
    playlistCache: {
      listPlaylists: () => ({ list: state.cacheList, updatedAt: 0 }),
      listSongs: () => ({ songs: state.cacheSongs, updatedAt: 0 }),
    },
  }),
}))

import { createLocalPlaylistStore } from '../../src/main/localPlaylistStore'
import {
  addLocalPlaylistSongs,
  createLocalPlaylist,
  getLocalPlaylistSongs,
  listLocalPlaylists,
  syncPlatformPlaylistToLocal,
} from '../../src/main/localPlaylistService'

const db = new Database(':memory:')
const store = createLocalPlaylistStore(db)
state.store = store

describe('localPlaylistService — 唯一标识与封面字段校验', () => {
  beforeEach(() => {
    db.exec('DELETE FROM local_playlist_songs; DELETE FROM local_playlists')
    state.cacheList = []
    state.cacheSongs = []
  })

  it('只透传已知唯一性字段，未知字段被丢弃', () => {
    const created = createLocalPlaylist(
      '测试歌单',
      [
        {
          title: '晴天',
          artist: '周杰伦',
          sourcePlatform: 'netease',
          sourceSongId: '186016',
          identifiers: {
            albumId: '14415',
            aliases: ['晴天 Live'],
            unknownField: 'drop-me',
          } as never,
        },
      ],
      {
        platform: 'netease',
        playlistId: '12345',
        extraIds: { gcid: 'gcid_abc', bad: '' },
      },
    )
    expect(created?.origin).toMatchObject({
      platform: 'netease',
      playlistId: '12345',
      extraIds: { gcid: 'gcid_abc' },
    })
    const songs = store.songs(created!.id)
    expect(songs[0].sourceSongId).toBe('186016')
    expect(songs[0].identifiers).toEqual({ albumId: '14415', aliases: ['晴天 Live'] })
  })

  it('来源歌单信息缺少平台或歌单 id 时拒绝写入', () => {
    expect(() =>
      createLocalPlaylist('测试歌单', [{ title: '晴天', artist: '周杰伦' }], {
        platform: 'netease',
      }),
    ).toThrow('无效的来源歌单信息')
    expect(store.list()).toHaveLength(0)
  })

  it('封面只接受 https：http/file 被丢弃，https 正常落库', () => {
    const created = createLocalPlaylist(
      '测试歌单',
      [
        {
          title: '晴天',
          artist: '周杰伦',
          coverUrl: 'http://p1.example/song.jpg',
        },
      ],
      {
        platform: 'netease',
        playlistId: '12345',
        coverUrl: 'https://p1.example/cover.jpg',
      },
    )
    expect(created?.coverUrl).toBe('https://p1.example/cover.jpg')
    expect(created?.coverSource).toBe('platform')
    expect(store.songs(created!.id)[0].coverUrl).toBeUndefined()

    const manual = createLocalPlaylist('手工歌单', [
      { title: '稻香', artist: '周杰伦', coverUrl: 'file:///tmp/a.jpg' },
    ])
    expect(manual?.coverUrl).toBeUndefined()
  })

  it('手工歌单首次添加带封面的歌曲后自动派生歌单封面', () => {
    const created = createLocalPlaylist('手工歌单', [{ title: '晴天', artist: '周杰伦' }])
    expect(created?.coverUrl).toBeUndefined()
    addLocalPlaylistSongs(created!.id, [
      { title: '稻香', artist: '周杰伦', coverUrl: 'https://p2.example/song.jpg' },
    ])
    const updated = store.get(created!.id)
    expect(updated?.coverUrl).toBe('https://p2.example/song.jpg')
    expect(updated?.coverSource).toBe('song')
    expect(store.songs(created!.id)[1].coverUrl).toBe('https://p2.example/song.jpg')
  })

  it('存量导入歌单：列表查询时从本地缓存惰性回填封面，不发网络请求', () => {
    const created = createLocalPlaylist('旧导入歌单', [{ title: '晴天', artist: '周杰伦' }], {
      platform: 'netease',
      playlistId: '12345',
    })
    expect(store.get(created!.id)?.coverUrl).toBeUndefined()
    state.cacheList = [{ id: '12345', coverUrl: 'https://p1.example/cached.jpg' }]
    const list = listLocalPlaylists()
    expect(list.find((p) => p.id === created!.id)?.coverUrl).toBe('https://p1.example/cached.jpg')
    expect(store.get(created!.id)?.coverSource).toBe('platform')
  })

  it('存量导入歌单的歌曲：读取时从平台歌曲缓存按位置回填封面', () => {
    const created = createLocalPlaylist(
      '旧导入歌单',
      [
        { title: '晴天', artist: '周杰伦', sourceSongId: '186016' },
        { title: '稻香', artist: '周杰伦', sourceSongId: '186017' },
      ],
      { platform: 'netease', playlistId: '12345' },
    )
    expect(store.songs(created!.id).every((s) => !s.coverUrl)).toBe(true)
    state.cacheSongs = [
      { id: '186016', coverUrl: 'https://p1.example/s1.jpg' },
      { id: '186017', coverUrl: 'https://p1.example/s2.jpg' },
    ]
    const songs = getLocalPlaylistSongs(created!.id)
    expect(songs.map((s) => s.coverUrl)).toEqual([
      'https://p1.example/s1.jpg',
      'https://p1.example/s2.jpg',
    ])
    // 回填结果已落库，后续读取无需再查缓存
    state.cacheSongs = []
    expect(getLocalPlaylistSongs(created!.id).map((s) => s.coverUrl)).toEqual([
      'https://p1.example/s1.jpg',
      'https://p1.example/s2.jpg',
    ])
  })

  it('同一平台歌单重复同步幂等增量，并可关联到已有本地歌单形成多来源', () => {
    const first = syncPlatformPlaylistToLocal(
      '同步歌单',
      [{ title: '晴天', artist: '周杰伦', sourceSongId: 's1' }],
      { platform: 'netease', playlistId: 'p1' },
    )
    expect(first.created).toBe(true)
    expect(first.added).toBe(1)
    expect(first.playlist.sources).toHaveLength(1)

    const second = syncPlatformPlaylistToLocal(
      '同步歌单',
      [
        { title: '晴天（修正）', artist: '周杰伦', sourceSongId: 's1' },
        { title: '稻香', artist: '周杰伦', sourceSongId: 's2' },
      ],
      { platform: 'netease', playlistId: 'p1' },
    )
    expect(second.created).toBe(false)
    expect(second.playlist.id).toBe(first.playlist.id)
    expect(second.added).toBe(1)
    expect(second.updated).toBe(1)
    expect(store.list()).toHaveLength(1)

    const merged = syncPlatformPlaylistToLocal(
      '同步歌单',
      [{ title: '晴天', artist: '周杰伦', sourceSongId: 'q1' }],
      { platform: 'qqmusic', playlistId: 'p2' },
      first.playlist.id,
    )
    expect(merged.created).toBe(false)
    expect(merged.playlist.sources?.map((s) => s.platform).sort()).toEqual(['netease', 'qqmusic'])
    expect(store.list()).toHaveLength(1)
  })
})
