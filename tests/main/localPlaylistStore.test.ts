import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createLocalPlaylistStore } from '../../src/main/localPlaylistStore'

const song = (title: string, artist = '') => ({ title, artist })

describe('localPlaylistStore — 本地歌单存储', () => {
  let store: ReturnType<typeof createLocalPlaylistStore>

  beforeEach(() => {
    store = createLocalPlaylistStore(new Database(':memory:'))
  })

  it('创建后可列出（按更新时间倒序），songCount 正确', () => {
    store.create('a', 'A 歌单', '2024-01-01T00:00:00.000Z')
    store.create('b', 'B 歌单', '2024-01-02T00:00:00.000Z')
    store.replaceSongs('a', [song('晴天', '周杰伦'), song('稻香', '周杰伦')], '2024-01-03T00:00:00.000Z')
    const list = store.list()
    expect(list.map((p) => p.id)).toEqual(['a', 'b'])
    expect(list[0].songCount).toBe(2)
    expect(list[1].songCount).toBe(0)
  })

  it('整单替换写入：旧歌曲被覆盖，位置重排', () => {
    store.create('a', 'A', '2024-01-01T00:00:00.000Z')
    store.replaceSongs('a', [song('1'), song('2'), song('3')], '2024-01-02T00:00:00.000Z')
    store.replaceSongs('a', [song('4')], '2024-01-03T00:00:00.000Z')
    const songs = store.songs('a')
    expect(songs.map((s) => s.title)).toEqual(['4'])
    expect(store.get('a')?.songCount).toBe(1)
  })

  it('追加歌曲：追加在末尾且位置连续', () => {
    store.create('a', 'A', '2024-01-01T00:00:00.000Z')
    store.replaceSongs('a', [song('1'), song('2')], '2024-01-02T00:00:00.000Z')
    store.addSongs('a', [song('3'), song('4')], '2024-01-03T00:00:00.000Z')
    expect(store.songs('a').map((s) => s.title)).toEqual(['1', '2', '3', '4'])
  })

  it('移除歌曲：按位置删除后剩余歌曲重排连续', () => {
    store.create('a', 'A', '2024-01-01T00:00:00.000Z')
    store.replaceSongs('a', [song('1'), song('2'), song('3'), song('4')], '2024-01-02T00:00:00.000Z')
    store.removeSongs('a', [1], '2024-01-03T00:00:00.000Z')
    expect(store.songs('a').map((s) => s.title)).toEqual(['1', '3', '4'])
    store.removeSongs('a', [0, 2], '2024-01-04T00:00:00.000Z')
    expect(store.songs('a').map((s) => s.title)).toEqual(['3'])
  })

  it('删除歌单：歌单与歌曲一并清除', () => {
    store.create('a', 'A', '2024-01-01T00:00:00.000Z')
    store.replaceSongs('a', [song('1')], '2024-01-02T00:00:00.000Z')
    store.remove('a')
    expect(store.list()).toHaveLength(0)
    expect(store.songs('a')).toHaveLength(0)
  })

  it('重命名生效且更新时间刷新', () => {
    store.create('a', 'A', '2024-01-01T00:00:00.000Z')
    store.rename('a', '新名字', '2024-01-05T00:00:00.000Z')
    const p = store.get('a')
    expect(p?.name).toBe('新名字')
    expect(p?.updatedAt).toBe('2024-01-05T00:00:00.000Z')
  })

  it('歌曲可选字段（歌手/专辑/时长）往返保持', () => {
    store.create('a', 'A', '2024-01-01T00:00:00.000Z')
    store.replaceSongs(
      'a',
      [{ title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 }],
      '2024-01-02T00:00:00.000Z',
    )
    const s = store.songs('a')[0]
    expect(s.title).toBe('晴天')
    expect(s.artist).toBe('周杰伦')
    expect(s.album).toBe('叶惠美')
    expect(s.durationMs).toBe(269000)
  })

  it('平台导出歌单：来源定位与歌曲唯一标识完整往返', () => {
    store.create(
      'x',
      '网易云歌单',
      '2024-01-01T00:00:00.000Z',
      {
        platform: 'netease',
        playlistId: '12345',
        webUrl: 'https://music.163.com/#/playlist?id=12345',
        ownerId: 'u-1',
        extraIds: { sourceType: 'created' },
      },
    )
    store.replaceSongs(
      'x',
      [
        {
          title: '晴天',
          artist: '周杰伦',
          sourcePlatform: 'netease',
          sourceSongId: '186016',
          identifiers: { albumId: '14415', aliases: ['晴天（Live）'] },
        },
      ],
      '2024-01-02T00:00:00.000Z',
    )
    expect(store.get('x')?.origin).toEqual({
      platform: 'netease',
      playlistId: '12345',
      webUrl: 'https://music.163.com/#/playlist?id=12345',
      appUrl: undefined,
      ownerId: 'u-1',
      extraIds: { sourceType: 'created' },
    })
    expect(store.songs('x')[0]).toMatchObject({
      sourcePlatform: 'netease',
      sourceSongId: '186016',
      identifiers: { albumId: '14415', aliases: ['晴天（Live）'] },
    })
  })
})
