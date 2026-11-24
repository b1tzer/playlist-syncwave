import { describe, it, expect, vi } from 'vitest'
import { NeteaseAdapter, type NcmApi } from '../../src/platforms/netease'

function makeApi(overrides: Partial<NcmApi> = {}): NcmApi {
  return {
    login_qr_key: async () => ({ body: { data: { unikey: 'key-1' } } }),
    login_qr_create: async () => ({
      body: { data: { qrimg: 'data:image/png;base64,AAAA' } },
    }),
    login_qr_check: async () => ({ body: { code: 801 } }),
    login_status: async () => ({
      body: { data: { account: { id: 12345 }, profile: { nickname: '测试' } } },
    }),
    user_playlist: async () => ({ body: { playlist: [] } }),
    playlist_detail: async () => ({ body: { playlist: { tracks: [] } } }),
    search: async () => ({ body: { result: { songs: [] } } }),
    playlist_create: async () => ({ body: { playlist: { id: 1 } } }),
    playlist_track_add: async () => ({ body: { code: 200 } }),
    ...overrides,
  }
}

describe('NeteaseAdapter — 映射契约', () => {
  it('二维码登录：key 与图片正确映射', async () => {
    const adapter = new NeteaseAdapter(makeApi())
    const ticket = await adapter.createQrLogin()
    expect(ticket).toEqual({ key: 'key-1', qrBase64: 'data:image/png;base64,AAAA' })
  })

  it('二维码轮询：801→waiting、802→scanned、800→expired、803→success+cookie', async () => {
    for (const [code, status] of [
      [801, 'waiting'],
      [802, 'scanned'],
      [800, 'expired'],
    ] as const) {
      const api = makeApi({ login_qr_check: async () => ({ body: { code } }) })
      expect(await new NeteaseAdapter(api).checkQrLogin('key-1')).toEqual({ status })
    }
    const api = makeApi({
      login_qr_check: async () => ({ body: { code: 803, cookie: 'MUSIC_U=abc' } }),
    })
    expect(await new NeteaseAdapter(api).checkQrLogin('key-1')).toEqual({
      status: 'success',
      cookie: 'MUSIC_U=abc',
    })
  })

  it('账号信息映射；无 userId 返回 null', async () => {
    const ok = await new NeteaseAdapter(makeApi()).getLoginStatus('MUSIC_U=abc')
    expect(ok).toEqual({ platform: 'netease', userId: '12345', nickname: '测试' })

    const none = await new NeteaseAdapter(
      makeApi({ login_status: async () => ({ body: { data: {} } }) }),
    ).getLoginStatus('bad')
    expect(none).toBeNull()
  })

  it('歌单列表映射：id/name/songCount', async () => {
    const api = makeApi({
      user_playlist: async () => ({
        body: { playlist: [{ id: 1, name: '我的收藏', trackCount: 42 }] },
      }),
    })
    const list = await new NeteaseAdapter(api).getUserPlaylists('c', '1')
    expect(list).toEqual([{ id: '1', name: '我的收藏', songCount: 42, coverUrl: undefined }])
  })

  it('歌单列表：过滤「我喜欢的音乐」（specialType=5）', async () => {
    const api = makeApi({
      user_playlist: async () => ({
        body: {
          playlist: [
            { id: 1, name: '普通歌单', trackCount: 10, specialType: 0 },
            { id: 5, name: '我喜欢的音乐', trackCount: 99, specialType: 5 },
          ],
        },
      }),
    })
    const list = await new NeteaseAdapter(api).getUserPlaylists('c', '1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('1')
  })

  it('搜索风控（405）→ 抛可重试 SearchError', async () => {
    const api = makeApi({
      search: async () => {
        const e = { status: 405, body: { code: 405, message: '操作频繁，请稍候再试' } }
        throw e
      },
    })
    await expect(new NeteaseAdapter(api).searchSongs('c', '晴天')).rejects.toMatchObject({
      message: '操作频繁，请稍候再试',
      retryable: true,
    })
  })

  it('歌单歌曲映射：多歌手拼接、时长毫秒', async () => {
    const api = makeApi({
      playlist_detail: async () => ({
        body: {
          playlist: {
            tracks: [
              {
                id: 7,
                name: '千里之外',
                ar: [{ name: '周杰伦' }, { name: '费玉清' }],
                al: { name: '依然范特西' },
                dt: 269000,
              },
            ],
          },
        },
      }),
    })
    const songs = await new NeteaseAdapter(api).getPlaylistSongs('c', '1')
    expect(songs).toEqual([
      {
        id: '7',
        title: '千里之外',
        artist: '周杰伦 / 费玉清',
        album: '依然范特西',
        durationMs: 269000,
      },
    ])
  })

  it('搜索映射与 limit 透传', async () => {
    const fn = vi.fn(async () => ({ body: { result: { songs: [] } } }))
    const api = makeApi({ search: fn })
    await new NeteaseAdapter(api).searchSongs('c', '晴天', 10)
    expect(fn).toHaveBeenCalledWith({ keywords: '晴天', type: 1, limit: 10, cookie: 'c' })
  })

  it('空响应不抛异常，返回空数组', async () => {
    const adapter = new NeteaseAdapter(makeApi())
    expect(await adapter.getUserPlaylists('c', '1')).toEqual([])
    expect(await adapter.getPlaylistSongs('c', '1')).toEqual([])
    expect(await adapter.searchSongs('c', 'x')).toEqual([])
  })

  it('创建歌单：返回新歌单 ID', async () => {
    const api = makeApi({
      playlist_create: async () => ({ body: { playlist: { id: 99 } } }),
    })
    expect(await new NeteaseAdapter(api).createPlaylist('c', '新歌单')).toBe('99')
  })

  it('创建歌单失败：抛出异常', async () => {
    const api = makeApi({ playlist_create: async () => ({ body: {} }) })
    await expect(new NeteaseAdapter(api).createPlaylist('c', 'x')).rejects.toThrow()
  })

  it('添加歌曲：ids 逗号拼接透传', async () => {
    const fn = vi.fn(async () => ({ body: { code: 200 } }))
    const api = makeApi({ playlist_track_add: fn })
    await new NeteaseAdapter(api).addSongsToPlaylist('c', '99', ['1', '2', '3'])
    expect(fn).toHaveBeenCalledWith({ op: 'add', pid: '99', ids: '1,2,3', cookie: 'c' })
  })

  it('添加歌曲：code 非 200 抛异常，空列表跳过', async () => {
    const bad = new NeteaseAdapter(
      makeApi({ playlist_track_add: async () => ({ body: { code: 502 } }) }),
    )
    await expect(bad.addSongsToPlaylist('c', '99', ['1'])).rejects.toThrow()

    const fn = vi.fn()
    const api = makeApi({ playlist_track_add: fn })
    await new NeteaseAdapter(api).addSongsToPlaylist('c', '99', [])
    expect(fn).not.toHaveBeenCalled()
  })

  it('重命名歌单：透传歌单 id 与新名称', async () => {
    const fn = vi.fn(async () => ({ body: { code: 200 } }))
    const api = makeApi({ playlist_name_update: fn })
    await new NeteaseAdapter(api).renamePlaylist('c', '99', '新名字')
    expect(fn).toHaveBeenCalledWith({ id: '99', name: '新名字', cookie: 'c' })
  })

  it('删除歌单：透传歌单 id', async () => {
    const fn = vi.fn(async () => ({ body: { code: 200 } }))
    const api = makeApi({ playlist_delete: fn })
    await new NeteaseAdapter(api).deletePlaylist('c', '99')
    expect(fn).toHaveBeenCalledWith({ id: '99', cookie: 'c' })
  })

  it('移除歌曲：ids 逗号拼接透传，空列表跳过', async () => {
    const fn = vi.fn(async () => ({ body: { code: 200 } }))
    const api = makeApi({ playlist_track_delete: fn })
    await new NeteaseAdapter(api).removeSongsFromPlaylist('c', '99', ['1', '2', '3'])
    expect(fn).toHaveBeenCalledWith({ id: '99', ids: '1,2,3', cookie: 'c' })

    const fn2 = vi.fn()
    const api2 = makeApi({ playlist_track_delete: fn2 })
    await new NeteaseAdapter(api2).removeSongsFromPlaylist('c', '99', [])
    expect(fn2).not.toHaveBeenCalled()
  })
})
