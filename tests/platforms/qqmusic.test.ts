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
        durationMs: 269000,
      },
    ])
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
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
    // key 请求带 channel=wechat
    expect(calls[0].url.searchParams.get('channel')).toBe('wechat')
    expect(calls[0].method).toBe('POST')
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

  it('歌单列表映射：tid/title/songCnt', async () => {
    const { handler } = makeHandler(() =>
      json({
        code: 200,
        playlist: [{ tid: 111, title: '我的歌单', songCnt: 33 }],
      }),
    )
    const adapter = new QqMusicAdapter(handler, env)
    const list = await adapter.getUserPlaylists('tok', '123')
    expect(list).toEqual([{ id: '111', name: '我的歌单', songCount: 33, coverUrl: undefined }])
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
        durationMs: 269000,
      },
    ])
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
  })

  it('创建歌单：POST body { name }，返回新歌单 ID', async () => {
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('POST')
      expect(url.pathname).toBe('/user/playlist/create')
      expect(body).toEqual({ name: '测试歌单' })
      return json({ code: 200, data: { tid: 222, dirId: 12 } })
    })
    const adapter = new QqMusicAdapter(handler, env)
    expect(await adapter.createPlaylist('tok', '测试歌单')).toBe('222')
    expect(calls[0].headers.get('x-qq-session')).toBe('tok')
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
})
