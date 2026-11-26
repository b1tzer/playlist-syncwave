import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  credential: 'token' as string | null,
  songs: [] as Array<Record<string, unknown>>,
  fetchedId: '',
  syncArgs: [] as unknown[],
}))

vi.mock('../../src/main/platformRegistry', () => ({
  getPlatform: vi.fn(() => ({ getCredential: () => state.credential })),
  resolveAdapter: vi.fn(async () => ({
    getPlaylistSongs: async (_credential: string, playlistId: string) => {
      state.fetchedId = playlistId
      return state.songs
    },
  })),
}))

vi.mock('../../src/main/localPlaylistService', () => ({
  syncPlatformPlaylistToLocal: vi.fn((...args: unknown[]) => {
    state.syncArgs = args
    return {
      playlist: { id: 'local-1', name: args[0] },
      created: args[3] === undefined,
      added: 1,
      updated: 0,
    }
  }),
}))

import { importPlatformPlaylistToLocal } from '../../src/main/localPlaylistImportService'

describe('importPlatformPlaylistToLocal — 平台歌单导出到本地', () => {
  beforeEach(() => {
    state.credential = 'token'
    state.fetchedId = ''
    state.syncArgs = []
    state.songs = []
  })

  it('拉取整单歌曲并把平台 id / 次级标识与来源定位传给同步服务', async () => {
    state.songs = [
      {
        id: '123',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        durationMs: 269000,
        identifiers: { albumId: '456', aliases: ['晴天 Live'] },
        coverUrl: 'https://p1.example/song.jpg',
      },
    ]
    const result = await importPlatformPlaylistToLocal('netease', {
      id: 'p-1',
      name: '我的歌单',
      webUrl: 'https://music.163.com/#/playlist?id=p-1',
      ownerId: 'u-1',
      extraIds: { sourceType: 'created' },
      coverUrl: 'https://p1.example/cover.jpg',
    })
    expect(result.playlist.id).toBe('local-1')
    expect(result.created).toBe(true)
    expect(state.fetchedId).toBe('p-1')
    expect(state.syncArgs[0]).toBe('我的歌单')
    expect(state.syncArgs[1]).toEqual([
      {
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        durationMs: 269000,
        sourcePlatform: 'netease',
        sourceSongId: '123',
        identifiers: { albumId: '456', aliases: ['晴天 Live'] },
        coverUrl: 'https://p1.example/song.jpg',
      },
    ])
    expect(state.syncArgs[2]).toEqual({
      platform: 'netease',
      playlistId: 'p-1',
      webUrl: 'https://music.163.com/#/playlist?id=p-1',
      appUrl: undefined,
      ownerId: 'u-1',
      extraIds: { sourceType: 'created' },
      coverUrl: 'https://p1.example/cover.jpg',
    })
  })

  it('透传目标本地歌单 id 以增量合并到已有歌单', async () => {
    state.songs = [{ id: '123', title: '晴天', artist: '周杰伦' }]
    await importPlatformPlaylistToLocal('netease', { id: 'p-1', name: '歌单' }, 'local-existing')
    expect(state.syncArgs[3]).toBe('local-existing')
  })

  it('未登录时拒绝导出', async () => {
    state.credential = null
    await expect(importPlatformPlaylistToLocal('netease', { id: 'p-1', name: '歌单' })).rejects.toThrow(
      '尚未登录',
    )
  })

  it('空歌单不创建本地歌单', async () => {
    await expect(importPlatformPlaylistToLocal('netease', { id: 'p-1', name: '歌单' })).rejects.toThrow(
      '没有歌曲',
    )
    expect(state.syncArgs).toEqual([])
  })
})
