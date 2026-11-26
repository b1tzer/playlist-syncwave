import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ store: null as unknown }))

vi.mock('../../src/main/appDatabase', () => ({
  getDatabase: () => ({ localPlaylists: state.store }),
}))

import { createLocalPlaylistStore } from '../../src/main/localPlaylistStore'
import { createLocalPlaylist } from '../../src/main/localPlaylistService'

const db = new Database(':memory:')
const store = createLocalPlaylistStore(db)
state.store = store

describe('localPlaylistService — 唯一标识字段校验', () => {
  beforeEach(() => {
    db.exec('DELETE FROM local_playlist_songs; DELETE FROM local_playlists')
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
})
