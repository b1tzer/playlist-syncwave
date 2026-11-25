import { describe, it, expect, vi } from 'vitest'
import { KugouAdapter, type KugouApi, type KugouDevice } from '../../src/platforms/kugou'

const DEVICE: KugouDevice = {
  guid: 'guid-1',
  mid: '123456789012345678901234567890',
  dev: 'ABCDEFGHIJ',
  dfid: 'DFID-1',
}

function makeApi(overrides: Partial<KugouApi> = {}): KugouApi {
  return {
    login_qr_key: async () => ({ status: 200, body: { data: { qrcode: 'key-1' } }, cookie: [] }),
    login_qr_create: async () => ({
      status: 200,
      body: { data: { base64: 'data:image/png;base64,AAAA' } },
      cookie: [],
    }),
    login_qr_check: async () => ({ status: 200, body: { data: { status: 1 } }, cookie: [] }),
    user_info: async () => {
      throw { status: 502, body: { error_msg: '接口不可用' }, cookie: [] }
    },
    user_detail: async () => ({
      status: 200,
      body: { data: { info: { userid: 123, nickname: '测试' } } },
      cookie: [],
    }),
    user_playlist: async () => ({ status: 200, body: { data: { info: [] } }, cookie: [] }),
    playlist_track_all_new: async () => ({ status: 200, body: { data: { info: [] } }, cookie: [] }),
    playlist_track_all: async () => ({ status: 200, body: { data: { info: [] } }, cookie: [] }),
    search: async () => ({ status: 200, body: { data: { lists: [] } }, cookie: [] }),
    playlist_add: async () => ({ status: 200, body: { data: { listid: 99 } }, cookie: [] }),
    playlist_tracks_add: async () => ({ status: 200, body: {}, cookie: [] }),
    playlist_tracks_del: async () => ({ status: 200, body: {}, cookie: [] }),
    playlist_del: async () => ({ status: 200, body: {}, cookie: [] }),
    playlist_update: async () => ({ status: 200, body: {}, cookie: [] }),
    register_dev: async () => ({ status: 200, body: { data: { dfid: 'DFID-2' } }, cookie: [] }),
    login_token: async () => ({
      status: 200,
      body: { data: { token: 't2', userid: 123, t1: 't1-1' } },
      cookie: [],
    }),
    ...overrides,
  }
}

describe('KugouAdapter — 映射契约', () => {
  it('二维码登录：key 与图片正确映射', async () => {
    const adapter = new KugouAdapter(makeApi(), DEVICE)
    const ticket = await adapter.createQrLogin()
    expect(ticket).toEqual({ key: 'key-1', qrBase64: 'data:image/png;base64,AAAA' })
  })

  it('二维码登录：无 dfid 时先注册设备', async () => {
    const register = vi.fn(async () => ({
      status: 200,
      body: { data: { dfid: 'DFID-2' } },
      cookie: [],
    }))
    const api = makeApi({ register_dev: register })
    const adapter = new KugouAdapter(api, { ...DEVICE, dfid: undefined })
    await adapter.createQrLogin()
    expect(register).toHaveBeenCalledTimes(1)
    // 注册成功后再次出码不再重复注册
    await adapter.createQrLogin()
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('二维码轮询：0→expired、2→scanned、1→waiting、4→success+cookie', async () => {
    for (const [status, result] of [
      [0, 'expired'],
      [2, 'scanned'],
      [1, 'waiting'],
    ] as const) {
      const api = makeApi({
        login_qr_check: async () => ({ status: 200, body: { data: { status } }, cookie: [] }),
      })
      expect(await new KugouAdapter(api, DEVICE).checkQrLogin('key-1')).toEqual({ status: result })
    }
    const api = makeApi({
      login_qr_check: async () => ({
        status: 200,
        body: { data: { status: 4, token: 'tok-1', userid: 456 } },
        cookie: [],
      }),
    })
    expect(await new KugouAdapter(api, DEVICE).checkQrLogin('key-1')).toEqual({
      status: 'success',
      cookie: 'token=tok-1;userid=456',
    })
  })

  it('账号信息映射；无 userId 返回 null', async () => {
    const ok = await new KugouAdapter(makeApi(), DEVICE).getLoginStatus('token=t;userid=123')
    expect(ok).toEqual({ platform: 'kugou', userId: '123', nickname: '测试' })

    const none = await new KugouAdapter(
      makeApi({ user_detail: async () => ({ status: 200, body: { data: {} }, cookie: [] }) }),
      DEVICE,
    ).getLoginStatus('bad')
    expect(none).toBeNull()
  })

  it('登录态：优先 get_my_userinfo 的平铺字段', async () => {
    const api = makeApi({
      user_info: async () => ({
        status: 200,
        body: { data: { userid: 789, nickname: '平铺昵称' } },
        cookie: [],
      }),
    })
    const account = await new KugouAdapter(api, DEVICE).getLoginStatus('token=t;userid=789')
    expect(account).toEqual({ platform: 'kugou', userId: '789', nickname: '平铺昵称' })
  })

  it('登录态：两接口失败时凭证 userid 兜底', async () => {
    const api = makeApi({
      user_info: async () => {
        throw { status: 502, body: { error_msg: '不可用' }, cookie: [] }
      },
      user_detail: async () => {
        throw { status: 502, body: { error_msg: '也不可用' }, cookie: [] }
      },
    })
    const account = await new KugouAdapter(api, DEVICE).getLoginStatus('token=t;userid=555')
    expect(account).toEqual({ platform: 'kugou', userId: '555', nickname: '酷狗用户' })
  })

  it('登录态：会话失效错误码不兜底，抛平台错误', async () => {
    const api = makeApi({
      user_info: async () => {
        throw { status: 502, body: { error_code: 20017, error_msg: '设备不匹配' }, cookie: [] }
      },
      user_detail: async () => {
        throw { status: 502, body: { error_code: 20017, error_msg: '设备不匹配' }, cookie: [] }
      },
    })
    await expect(
      new KugouAdapter(api, DEVICE).getLoginStatus('token=t;userid=555'),
    ).rejects.toThrow('设备不匹配')
  })

  it('歌单列表映射：id/name/songCount/coverUrl', async () => {
    const api = makeApi({
      user_playlist: async () => ({
        status: 200,
        body: {
          data: {
            info: [
              {
                listid: 5,
                name: '我的歌单',
                song_count: 42,
                pic: 'https://img.example/a.jpg',
                list_type: 0,
                total_ver: 7,
                global_collection_id: 'collection_3_1_4_0',
              },
            ],
          },
        },
        cookie: [],
      }),
    })
    const list = await new KugouAdapter(api, DEVICE).getUserPlaylists('c', '1')
    expect(list).toEqual([
      {
        id: '5',
        name: '我的歌单',
        songCount: 42,
        coverUrl: 'https://img.example/a.jpg',
      },
    ])
  })

  it('歌单歌曲映射：hash 小写 id、时长毫秒、fileid 缓存', async () => {
    const del = vi.fn(async () => ({ status: 200, body: {}, cookie: [] }))
    const api = makeApi({
      user_playlist: async () => ({
        status: 200,
        body: {
          data: { info: [{ listid: 5, name: 'x', song_count: 1, list_type: 0, total_ver: 0 }] },
        },
        cookie: [],
      }),
      playlist_track_all_new: async () => ({
        status: 200,
        body: {
          data: {
            info: [
              {
                hash: 'ABC123',
                name: '晴天',
                singer: '周杰伦',
                album_name: '叶惠美',
                album_id: 77,
                mixsongid: 88,
                fileid: 1001,
                duration: 269,
              },
            ],
          },
        },
        cookie: [],
      }),
      playlist_tracks_del: del,
    })
    const adapter = new KugouAdapter(api, DEVICE)
    const songs = await adapter.getPlaylistSongs('c', '5')
    expect(songs).toEqual([
      {
        id: 'abc123',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        coverUrl: undefined,
        durationMs: 269000,
      },
    ])
    // fileid 缓存生效：删歌直接映射，不再拉取歌单歌曲
    await adapter.removeSongsFromPlaylist('c', '5', ['abc123'])
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({ listid: '5', fileids: '1001' }),
    )
  })

  it('歌单歌曲：云歌单接口空时回退公开歌单接口', async () => {
    const fallback = vi.fn(async () => ({
      status: 200,
      body: { data: { info: [{ hash: 'DEF456', filename: '后来 - 刘若英', duration: 240 }] } },
      cookie: [],
    }))
    const api = makeApi({
      user_playlist: async () => ({
        status: 200,
        body: {
          data: {
            info: [
              {
                listid: 5,
                name: 'x',
                song_count: 1,
                list_type: 1,
                total_ver: 0,
                global_collection_id: 'collection_3_1_4_0',
              },
            ],
          },
        },
        cookie: [],
      }),
      playlist_track_all_new: async () => ({ status: 200, body: { data: { info: [] } }, cookie: [] }),
      playlist_track_all: fallback,
    })
    const adapter = new KugouAdapter(api, DEVICE)
    const songs = await adapter.getPlaylistSongs('c', '5')
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'collection_3_1_4_0' }),
    )
    expect(songs[0]).toMatchObject({ id: 'def456', title: '后来', artist: '刘若英' })
  })

  it('搜索映射：高亮标签清理、{size} 占位替换、结果缓存', async () => {
    const api = makeApi({
      search: async () => ({
        status: 200,
        body: {
          data: {
            lists: [
              [
                {
                  FileHash: 'ABC123',
                  SongName: '<em>晴天</em>',
                  SingerName: '周杰伦',
                  AlbumName: '叶惠美',
                  AlbumID: 77,
                  MixSongID: 88,
                  Image: 'https://img.example/{size}/a.jpg',
                  Duration: 269,
                },
              ],
            ],
          },
        },
        cookie: [],
      }),
    })
    const adapter = new KugouAdapter(api, DEVICE)
    const songs = await adapter.searchSongs('c', '晴天')
    expect(songs).toEqual([
      {
        id: 'abc123',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        coverUrl: 'https://img.example/480/a.jpg',
        durationMs: 269000,
      },
    ])
    // 搜索结果缓存的元数据支撑加歌
    const add = vi.fn(async () => ({ status: 200, body: {}, cookie: [] }))
    const api2 = makeApi({ search: api.search, playlist_tracks_add: add })
    const adapter2 = new KugouAdapter(api2, DEVICE)
    await adapter2.searchSongs('c', '晴天')
    await adapter2.addSongsToPlaylist('c', '99', ['abc123'])
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ listid: '99', data: '晴天|abc123|77|88' }),
    )
  })

  it('搜索错误分类：502 可重试、error_code=1002 限流', async () => {
    const retryable = new KugouAdapter(
      makeApi({
        search: async () => {
          throw { status: 502, body: { error_msg: '网络错误' }, cookie: [] }
        },
      }),
      DEVICE,
    )
    await expect(retryable.searchSongs('c', '晴天')).rejects.toMatchObject({
      message: '酷狗：网络错误',
      retryable: true,
      rateLimited: false,
    })

    const limited = new KugouAdapter(
      makeApi({
        search: async () => {
          throw { status: 502, body: { error_code: 1002, error_msg: '操作频繁' }, cookie: [] }
        },
      }),
      DEVICE,
    )
    await expect(limited.searchSongs('c', '晴天')).rejects.toMatchObject({
      message: '酷狗：操作频繁',
      retryable: true,
      rateLimited: true,
    })
  })

  it('创建歌单：返回新歌单 ID；失败抛异常', async () => {
    const api = makeApi()
    expect(await new KugouAdapter(api, DEVICE).createPlaylist('c', '新歌单')).toBe('99')

    const bad = new KugouAdapter(
      makeApi({ playlist_add: async () => ({ status: 200, body: {}, cookie: [] }) }),
      DEVICE,
    )
    await expect(bad.createPlaylist('c', 'x')).rejects.toThrow('酷狗：创建歌单失败')
  })

  it('添加歌曲：元数据缓存 miss 时抛明确错误', async () => {
    const adapter = new KugouAdapter(makeApi(), DEVICE)
    await expect(adapter.addSongsToPlaylist('c', '99', ['unknown'])).rejects.toThrow(
      '缺少元数据',
    )
  })

  it('重命名歌单：索引 miss 时重拉列表并携带 total_ver', async () => {
    const update = vi.fn(async () => ({ status: 200, body: {}, cookie: [] }))
    const api = makeApi({
      user_playlist: async () => ({
        status: 200,
        body: {
          data: {
            info: [{ listid: 5, name: '我的歌单', song_count: 1, list_type: 0, total_ver: 7 }],
          },
        },
        cookie: [],
      }),
      playlist_update: update,
    })
    const adapter = new KugouAdapter(api, DEVICE)
    await adapter.renamePlaylist('c', '5', '新名字')
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ listid: '5', name: '新名字', type: 0, total_ver: 7 }),
    )
  })

  it('删除歌单：透传歌单 id', async () => {
    const del = vi.fn(async () => ({ status: 200, body: {}, cookie: [] }))
    const api = makeApi({ playlist_del: del })
    await new KugouAdapter(api, DEVICE).deletePlaylist('c', '99')
    expect(del).toHaveBeenCalledWith(expect.objectContaining({ listid: '99' }))
  })

  it('保活：login_token 续期返回新凭证；失败回退登录态校验', async () => {
    const ok = await new KugouAdapter(makeApi(), DEVICE).keepAlive('token=t1;userid=123')
    expect(ok).toEqual({ alive: true, cookie: 'token=t2;userid=123;t1=t1-1' })

    const fallback = new KugouAdapter(
      makeApi({
        login_token: async () => {
          throw { status: 502, body: { error_msg: '刷新失败' }, cookie: [] }
        },
      }),
      DEVICE,
    )
    expect(await fallback.keepAlive('token=t1;userid=123')).toEqual({ alive: true })

    const dead = new KugouAdapter(
      makeApi({
        login_token: async () => {
          throw { status: 502, body: { error_code: 20017, error_msg: '设备不匹配' }, cookie: [] }
        },
      }),
      DEVICE,
    )
    expect(await dead.keepAlive('token=t1;userid=123')).toEqual({ alive: false })
  })

  it('空响应不抛异常，返回空数组；未知歌单抛错', async () => {
    const adapter = new KugouAdapter(makeApi(), DEVICE)
    expect(await adapter.getUserPlaylists('c', '1')).toEqual([])
    expect(await adapter.searchSongs('c', 'x')).toEqual([])
    await expect(adapter.getPlaylistSongs('c', 'nonexistent')).rejects.toThrow('找不到歌单')
  })
})
