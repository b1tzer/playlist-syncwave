import { describe, it, expect } from 'vitest'
import { QqMusicAdapter } from '../../src/platforms/qqmusic'
import type { HttpHandler } from '../../src/platforms/httpHandler'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers })
}

/** 记录请求并返回预设响应的 handler */
function makeHandler(
  responder: (method: string, url: URL, body?: unknown) => Response,
): { handler: HttpHandler; calls: Array<{ method: string; url: URL; body?: unknown; headers: Headers }> } {
  const calls: Array<{ method: string; url: URL; body?: unknown; headers: Headers }> = []
  const handler: HttpHandler = async (request) => {
    const url = new URL(request.url)
    const body = request.body ? await request.json().catch(() => undefined) : undefined
    calls.push({ method: request.method, url, body, headers: request.headers })
    return responder(request.method, url, body)
  }
  return { handler, calls }
}

const env = { QQ_SESSION_SECRET: 'secret-0123456789abcdef0123456789abcdef' }
const SONG = {
  id: 97773,
  mid: '0039MnYb0qxYhV',
  name: '晴天',
  title: '晴天',
  singer: [{ name: '周杰伦' }],
  album: { name: '叶惠美' },
  albummid: '000MkMni19ClKG',
  interval: 269,
}

describe('QqMusicAdapter — serverless HTTP 映射', () => {
  it('搜索：正确路径与参数，映射歌曲字段（interval 秒→毫秒）', async () => {
    const { handler, calls } = makeHandler((method, url) => {
      expect(method).toBe('GET')
      expect(url.pathname).toBe('/search')
      expect(url.searchParams.get('keyword')).toBe('晴天')
      expect(url.searchParams.get('type')).toBe('song')
      return json({ code: 200, items: [SONG] })
    })
    const adapter = new QqMusicAdapter(handler, env)
    const songs = await adapter.searchSongs('tok', '晴天', 10)
    expect(songs).toEqual([
      {
        id: '97773',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        coverUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg',
        durationMs: 269000,
      },
    ])
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
  })

  it('搜索封面：直接 URL 字段优先于 albummid 拼图床', async () => {
    const { handler } = makeHandler(() =>
      json({
        code: 200,
        items: [
          {
            id: 1,
            mid: 'm1',
            name: '歌',
            singer: [],
            albumPic: 'https://cdn.example.com/cover.jpg',
            albummid: 'A1',
          },
        ],
      }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    const songs = await adapter.searchSongs('tok', '歌', 10)
    expect(songs[0].coverUrl).toBe('https://cdn.example.com/cover.jpg')
  })

  it('搜索封面：无专辑 mid 时用歌曲 mid 拼歌曲图兜底', async () => {
    const { handler } = makeHandler(() =>
      json({ code: 200, items: [{ id: 1, mid: 'm1', name: '歌', singer: [] }] }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    const songs = await adapter.searchSongs('tok', '歌', 10)
    expect(songs[0].coverUrl).toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000m1.jpg')
  })

  it('搜索封面：album.mid 对象形式同样可拼图床', async () => {
    const { handler } = makeHandler(() =>
      json({
        code: 200,
        items: [{ id: 1, mid: 'm1', name: '歌', singer: [], album: { mid: 'A2', name: '专辑' } }],
      }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    const songs = await adapter.searchSongs('tok', '歌', 10)
    expect(songs[0].coverUrl).toBe('https://y.gtimg.cn/music/photo_new/T002R500x500M000A2.jpg')
  })

  it('二维码登录：key → create → 返回 qrBase64', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      if (url.pathname === '/login/qr/key') {
        return json({ code: 200, data: { unikey: 'uk-1' } })
      }
      if (url.pathname === '/login/qr/create') {
        expect(url.searchParams.get('key')).toBe('uk-1')
        return json({ code: 200, data: { qrimg: 'data:image/png;base64,ABC' } })
      }
      throw new Error('unexpected')
    })
    const adapter = new QqMusicAdapter(handler, env)
    const ticket = await adapter.createQrLogin()
    expect(ticket).toEqual({ key: 'uk-1', qrBase64: 'data:image/png;base64,ABC' })
    // key 请求默认 channel=qqmusic
    expect(calls[0].url.searchParams.get('channel')).toBe('qqmusic')
    expect(calls[0].method).toBe('GET')
  })

  it('二维码登录：支持指定通道（wechat/qq）', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      if (url.pathname === '/login/qr/key') {
        expect(url.searchParams.get('channel')).toBe('wechat')
        return json({ code: 200, data: { unikey: 'uk-2' } })
      }
      return json({ code: 200, data: { qrimg: 'data:image/png;base64,XYZ' } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    const ticket = await adapter.createQrLogin('wechat')
    expect(ticket.key).toBe('uk-2')
    expect(calls[0].url.searchParams.get('channel')).toBe('wechat')
  })

  it('二维码登录：空字符串通道回退到默认 qqmusic（生产版 400 回归）', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      if (url.pathname === '/login/qr/key') {
        return json({ code: 200, data: { unikey: 'uk-empty' } })
      }
      return json({ code: 200, data: { qrimg: 'data:image/png;base64,EMPTY' } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    const ticket = await adapter.createQrLogin('')
    expect(ticket.key).toBe('uk-empty')
    expect(calls[0].url.searchParams.get('channel')).toBe('qqmusic')
  })

  it('二维码轮询：800→expired、801→waiting、802→scanned、803→success', async () => {
    for (const [code, status] of [
      [800, 'expired'],
      [801, 'waiting'],
      [802, 'scanned'],
    ] as const) {
      const { handler } = makeHandler(() => json({ code }))
      const adapter = new QqMusicAdapter(handler, env)
      expect(await adapter.checkQrLogin('k')).toEqual({ status })
    }
    const { handler } = makeHandler(() =>
      json({ code: 803 }, 200, { 'set-cookie': 'qqmusic_session=sealed-tok; Max-Age=86400' }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    expect(await adapter.checkQrLogin('k')).toEqual({
      status: 'success',
      cookie: 'sealed-tok',
    })
  })

  it('登录状态：无 profile 返回 null，有 profile 返回账号', async () => {
    const empty = makeHandler(() => json({ code: 200, data: {} }))
    expect(await new QqMusicAdapter(empty.handler, env).getLoginStatus('tok')).toBeNull()

    const ok = makeHandler(() =>
      json({ code: 200, data: { profile: { musicid: '123', nickname: '测试用户' } } }),
    )
    const account = await new QqMusicAdapter(ok.handler, env).getLoginStatus('tok')
    expect(account).toEqual({ platform: 'qqmusic', userId: '123', nickname: '测试用户' })
  })

  it('登录状态：昵称在嵌套 info 对象里（GetLoginUserInfo 真实结构）', async () => {
    const { handler } = makeHandler(() =>
      json({
        code: 200,
        data: {
          profile: {
            musicid: '456',
            str_musicid: '456',
            errMsg: '',
            identify: {},
            info: { nickname: '微信用户', headurl: 'http://x/a.jpg' },
            celebrityInfo: {},
          },
        },
      }),
    )
    const account = await new QqMusicAdapter(handler, env).getLoginStatus('tok')
    expect(account).toEqual({ platform: 'qqmusic', userId: '456', nickname: '微信用户' })
  })

  it('歌单列表映射：tid/dirName/songNum（QQ音乐真实字段）', async () => {
    const { handler } = makeHandler(() =>
      json({
        code: 200,
        playlist: [{ tid: 111, dirName: '我的歌单', songNum: 33, picUrl: 'http://x/y.jpg' }],
      }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    const list = await adapter.getUserPlaylists('tok', '123')
    expect(list).toEqual([
      {
        id: '111',
        name: '我的歌单',
        songCount: 33,
        coverUrl: 'https://x/y.jpg',
        webUrl: 'https://y.qq.com/n/ryqq/playlist/111',
        appUrl: 'qqmusic://qq.com/media/playSonglist?p=111',
      },
    ])
  })

  it('歌单列表：过滤收藏类（dirId >= 200 的我喜欢与收藏歌单）', async () => {
    const { handler } = makeHandler(() =>
      json({
        code: 200,
        playlist: [
          { tid: 1, dirId: 1, dirName: '自建歌单', songNum: 10 },
          { tid: 2, dirId: 201, dirName: '我喜欢', songNum: 77 },
          { tid: 3, dirId: 8314, name: '收藏的歌单', songnum: 99 },
        ],
      }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    const list = await adapter.getUserPlaylists('tok', '123')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('1')
    expect(list[0].name).toBe('自建歌单')
  })

  it('歌单歌曲映射：songlist → 平台歌曲', async () => {
    const { handler, calls } = makeHandler((_, url) => {
      expect(url.pathname).toBe('/user/playlist-detail')
      expect(url.searchParams.get('tid')).toBe('111')
      return json({
        code: 200,
        songs: [
          {
            songid: '97773',
            songname: '晴天',
            singer: [{ name: '周杰伦' }],
            albumname: '叶惠美',
            albummid: '000MkMni19ClKG',
            interval: 269,
          },
        ],
      })
    })
    const adapter = new QqMusicAdapter(handler, env)
    const songs = await adapter.getPlaylistSongs('tok', '111')
    expect(songs).toEqual([
      {
        id: '97773',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        coverUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000MkMni19ClKG.jpg',
        durationMs: 269000,
        identifiers: { albumMid: '000MkMni19ClKG' },
      },
    ])
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
  })

  it('创建歌单：POST body { name }，新协议顶层 tid 返回新歌单 ID', async () => {
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/user/playlist/create')
      expect(body).toEqual({ name: '测试歌单' })
      // 3.3.5+ 新协议成功响应：tid 在顶层
      return json({ code: 200, tid: 222, dirId: 12, name: '测试歌单', verified: true })
    })
    const adapter = new QqMusicAdapter(handler, env)
    expect(await adapter.createPlaylist('tok', '测试歌单')).toBe('222')
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
  })

  it('创建歌单：兼容旧协议 data.tid 响应', async () => {
    const { handler } = makeHandler(() => json({ code: 200, data: { tid: 333 } }))
    const adapter = new QqMusicAdapter(handler, env)
    expect(await adapter.createPlaylist('tok', '旧协议')).toBe('333')
  })

  it('创建歌单：名称超过 20 字符 → 明确报错且不发请求', async () => {
    const { handler, calls } = makeHandler(() => {
      throw new Error('unexpected')
    })
    const adapter = new QqMusicAdapter(handler, env)
    await expect(adapter.createPlaylist('tok', '一二三四五六七八九十一二三四五六七八九十多')).rejects.toThrow(
      '歌单名最多 20 个字符',
    )
    expect(calls).toHaveLength(0)
  })

  it('创建歌单：名称首尾空白去除后提交', async () => {
    const { handler, calls } = makeHandler((_method, _url, body) => {
      expect(body).toEqual({ name: '去空白' })
      return json({ code: 200, tid: 444 })
    })
    const adapter = new QqMusicAdapter(handler, env)
    expect(await adapter.createPlaylist('tok', '  去空白  ')).toBe('444')
    expect(calls).toHaveLength(1)
  })

  it('添加歌曲：songs 数组为 {id, type:0}，每批 ≤100', async () => {
    const { handler, calls } = makeHandler((method, url) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/user/playlist/tracks')
      return json({ code: 200, data: { changed: true } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    await adapter.addSongsToPlaylist('tok', '222', ['1', '2'])
    expect(calls[0].body).toEqual({
      tid: 222,
      op: 'add',
      songs: [
        { id: 1, type: 0 },
        { id: 2, type: 0 },
      ],
    })
  })

  it('401 / 错误响应 → 抛可分类异常', async () => {
    const { handler } = makeHandler(() =>
      json({ code: 401, message: 'Login required' }, 401),
    )
    const adapter = new QqMusicAdapter(handler, env)
    await expect(adapter.getUserPlaylists('bad', '1')).rejects.toThrow()
  })

  it('重命名歌单：POST /user/playlist/rename，body { tid, name }', async () => {
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/user/playlist/rename')
      expect(body).toEqual({ tid: 222, name: '新名字' })
      return json({ code: 200, data: { changed: true } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    await adapter.renamePlaylist('tok', '222', '新名字')
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
  })

  it('删除歌单：POST /user/playlist/delete，body { tid }', async () => {
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/user/playlist/delete')
      expect(body).toEqual({ tid: 222 })
      return json({ code: 200, data: { deleted: true } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    await adapter.deletePlaylist('tok', '222')
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
  })

  it('移除歌曲：POST /user/playlist/tracks op=del，空列表跳过', async () => {
    const { handler, calls } = makeHandler((method, url) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/user/playlist/tracks')
      return json({ code: 200, data: { changed: true } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    await adapter.removeSongsFromPlaylist('tok', '222', ['1', '2'])
    expect(calls[0].body).toEqual({
      tid: 222,
      op: 'del',
      songs: [
        { id: 1, type: 0 },
        { id: 2, type: 0 },
      ],
    })

    const empty = makeHandler(() => json({ code: 200 }))
    await new QqMusicAdapter(empty.handler, env).removeSongsFromPlaylist('tok', '222', [])
    expect(empty.calls.length).toBe(0)
  })
})
