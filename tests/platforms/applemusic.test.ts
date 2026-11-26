import { describe, it, expect } from 'vitest'
import { AppleMusicAdapter } from '../../src/platforms/applemusic'
import type { HttpHandler } from '../../src/platforms/httpHandler'
import { SearchError } from '../../src/core/models/sync'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status })
}

function empty(status = 204): Response {
  // 204 状态不允许非空 body，用 null
  return new Response(null, { status })
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

/** 构造三段 JWT（payload 可校验） */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = Buffer.from('signature-signature-signature').toString('base64url')
  return `${header}.${body}.${sig}`
}

const WEB_TOKEN = makeJwt({ iss: 'AMPWebPlay', exp: 4102444800 })

/** 凭证串（devTokenAt 默认现在，避免触发重抓） */
function cred(overrides: Partial<{ mediaUserToken: string; developerToken: string; devTokenAt: number; nickname: string; email: string }> = {}): string {
  return JSON.stringify({
    v: 1,
    mediaUserToken: 'user-tok',
    developerToken: 'dev-tok',
    devTokenAt: Date.now(),
    ...overrides,
  })
}

/** 网页前端抓取 mock：首页 HTML 引 bundle，bundle JS 内嵌公开 token */
function webFrontResponder(url: URL): Response | null {
  if (url.hostname === 'music.apple.com' && url.pathname === '/cn/browse') {
    return new Response('<html><script src="/assets/index-abc123.js"></script></html>', { status: 200 })
  }
  if (url.pathname === '/assets/index-abc123.js') {
    return new Response(`const token="${WEB_TOKEN}";`, { status: 200 })
  }
  return null
}

const STOREFRONT = { data: [{ id: 'cn', type: 'storefronts' }] }

const PLAYLIST = {
  id: 'pl.u-ABC123',
  type: 'library-playlists',
  attributes: { name: '我的歌单', artwork: { url: 'https://x/{w}x{h}bb.jpg' } },
}

const TRACK = {
  id: 'i.LIB1',
  type: 'library-songs',
  attributes: {
    name: '晴天',
    artistName: '周杰伦',
    albumName: '叶惠美',
    durationInMillis: 269000,
    genreNames: ['Mandopop'],
    artwork: { url: 'https://x/{w}x{h}bb.jpg' },
    playParams: { catalogId: '97773' },
  },
}

describe('AppleMusicAdapter — 社区路径 HTTP 映射', () => {
  it('webLoginSetup：从网页前端提取 developer token 并构造凭证', async () => {
    const { handler } = makeHandler((_method, url) => {
      const page = webFrontResponder(url)
      if (page) return page
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const value = await adapter.webLoginSetup('session-1')
    const parsed = JSON.parse(value) as { mediaUserToken: string; developerToken: string }
    expect(parsed.mediaUserToken).toBe('session-1')
    expect(parsed.developerToken).toBe(WEB_TOKEN)
  })

  it('webLoginSetup：页面抓到的昵称与邮箱写入凭证，登录态据此显示', async () => {
    const { handler } = makeHandler((_method, url) => {
      const page = webFrontResponder(url)
      if (page) return page
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const value = await adapter.webLoginSetup('session-2', {
      nickname: '页面上的名字',
      email: 'user@example.com',
    })
    expect(JSON.parse(value) as { nickname?: string; email?: string }).toMatchObject({
      nickname: '页面上的名字',
      email: 'user@example.com',
    })

    const { handler: statusHandler } = makeHandler(() => json(STOREFRONT))
    const statusAdapter = new AppleMusicAdapter(statusHandler, {})
    expect(await statusAdapter.getLoginStatus(value)).toEqual({
      platform: 'applemusic',
      userId: 'cn',
      nickname: '页面上的名字',
      account: 'user@example.com',
    })
  })

  it('最小凭证：只有 mediaUserToken 时保活自动补 developer token', async () => {
    const { handler } = makeHandler((_method, url) => {
      const page = webFrontResponder(url)
      if (page) return page
      if (url.pathname === '/v1/me/storefront') return json(STOREFRONT)
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const minimal = JSON.stringify({
      v: 1,
      mediaUserToken: 'user-tok',
      developerToken: '',
      devTokenAt: 0,
    })
    const kept = await adapter.keepAlive(minimal)
    expect(kept.alive).toBe(true)
    expect(kept.cookie).toBeTruthy()
    const parsed = JSON.parse(kept.cookie!) as { developerToken: string; devTokenAt: number }
    expect(parsed.developerToken).toBe(WEB_TOKEN)
    expect(parsed.devTokenAt).toBeGreaterThan(0)
  })

  it('withWebLoginProfile：后台抓到的昵称与邮箱补进已有凭证', () => {
    const { handler } = makeHandler(() => json({}))
    const adapter = new AppleMusicAdapter(handler, {})
    const updated = adapter.withWebLoginProfile(cred(), {
      nickname: '后台抓到的名字',
      email: 'user@example.com',
    })
    expect(JSON.parse(updated) as Record<string, unknown>).toMatchObject({
      mediaUserToken: 'user-tok',
      nickname: '后台抓到的名字',
      email: 'user@example.com',
    })
  })

  it('登录态：/v1/me/storefront 200 返回 storefront 作为账号标识', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      expect(url.hostname).toBe('api.music.apple.com')
      expect(url.pathname).toBe('/v1/me/storefront')
      return json(STOREFRONT)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const account = await adapter.getLoginStatus(cred())
    expect(account).toEqual({ platform: 'applemusic', userId: 'cn', nickname: 'Apple Music 用户' })
    expect(calls[0].headers.get('authorization')).toBe('Bearer dev-tok')
    expect(calls[0].headers.get('music-user-token')).toBe('user-tok')
    expect(calls[0].headers.get('origin')).toBe('https://music.apple.com')
  })

  it('登录态：403 返回 null（凭证失效）', async () => {
    const { handler } = makeHandler(() => empty(403))
    const adapter = new AppleMusicAdapter(handler, {})
    const account = await adapter.getLoginStatus(cred())
    expect(account).toBeNull()
  })

  it('歌单列表：跟随 next 分页（next 已带 /v1 前缀）并映射字段', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      expect(url.pathname).toBe('/v1/me/library/playlists')
      const offset = url.searchParams.get('offset')
      if (offset === '0') {
        return json({ data: [PLAYLIST], next: '/v1/me/library/playlists?limit=100&offset=100' })
      }
      return json({ data: [] })
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const playlists = await adapter.getUserPlaylists(cred(), 'cn')
    expect(playlists).toHaveLength(1)
    expect(playlists[0]).toMatchObject({
      id: 'pl.u-ABC123',
      name: '我的歌单',
      coverUrl: 'https://x/300x300bb.jpg',
      webUrl: 'https://music.apple.com/library/playlist/pl.u-ABC123',
    })
    // 官方列表接口 attributes 无 trackCount 字段：不虚构 0，缺省为 undefined
    expect(playlists[0].songCount).toBeUndefined()
    expect(calls).toHaveLength(2)
    // 第二次请求直接使用响应 next（/v1 前缀已带）
    expect(calls[1].url.pathname).toBe('/v1/me/library/playlists')
  })

  it('歌单列表：官方歌单（pl. 前缀）给公开目录链接，用户歌单（pl.u- 前缀）给资料库链接', async () => {
    const { handler } = makeHandler(() =>
      json({
        data: [
          { id: 'pl.official1', type: 'library-playlists', attributes: { name: '官方歌单' } },
          { id: 'pl.u-mine1', type: 'library-playlists', attributes: { name: '用户歌单' } },
        ],
      }),
    )
    const adapter = new AppleMusicAdapter(handler, {})
    const playlists = await adapter.getUserPlaylists(cred(), 'cn')
    expect(playlists[0].webUrl).toBe('https://music.apple.com/playlist/pl.official1')
    expect(playlists[1].webUrl).toBe('https://music.apple.com/library/playlist/pl.u-mine1')
  })

  it('歌单列表：attributes 提供 trackCount 时透出（防御未来字段补充）', async () => {
    const { handler } = makeHandler(() =>
      json({
        data: [
          {
            id: 'p.COUNTED',
            type: 'library-playlists',
            attributes: { name: '计数歌单', trackCount: 42 },
          },
        ],
      }),
    )
    const adapter = new AppleMusicAdapter(handler, {})
    const playlists = await adapter.getUserPlaylists(cred(), 'cn')
    expect(playlists[0].songCount).toBe(42)
  })

  it('歌单歌曲：优先用 playParams.catalogId 作为歌曲 id', async () => {
    const { handler } = makeHandler((_method, url) => {
      expect(url.pathname).toBe('/v1/me/library/playlists/p.ABC123/tracks')
      return json({ data: [TRACK] })
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const songs = await adapter.getPlaylistSongs(cred(), 'p.ABC123')
    expect(songs).toEqual([
      {
        id: '97773',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        coverUrl: 'https://x/300x300bb.jpg',
        durationMs: 269000,
        genre: 'Mandopop',
        identifiers: { librarySongId: 'i.LIB1' },
      },
    ])
  })

  it('搜索：清洗 " - " 分隔符、走 catalog 端点、storefront 自动获取', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      if (url.pathname === '/v1/me/storefront') return json(STOREFRONT)
      if (url.pathname === '/v1/catalog/cn/search') {
        expect(url.searchParams.get('term')).toBe('Hotel California Eagles')
        expect(url.searchParams.get('types')).toBe('songs')
        return json({ results: { songs: { data: [TRACK] } } })
      }
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const songs = await adapter.searchSongs(cred(), 'Hotel California - Eagles', 10)
    expect(songs[0]).toMatchObject({ id: '97773', title: '晴天' })
    expect(calls[0].url.pathname).toBe('/v1/me/storefront')
  })

  it('搜索：limit 超过 API 上限 25 时钳制到 25', async () => {
    const { handler, calls } = makeHandler((_method, url) => {
      if (url.pathname === '/v1/me/storefront') return json(STOREFRONT)
      if (url.pathname === '/v1/catalog/cn/search') {
        return json({ results: { songs: { data: [TRACK] } } })
      }
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    await adapter.searchSongs(cred(), 'hello', 30)
    const searchCall = calls.find((c) => c.url.pathname === '/v1/catalog/cn/search')
    expect(searchCall?.url.searchParams.get('limit')).toBe('25')
  })

  it('搜索：400 错误带状态码后缀，归类为不可重试', async () => {
    const { handler } = makeHandler((_method, url) => {
      if (url.pathname === '/v1/me/storefront') return json(STOREFRONT)
      return json({ errors: [{ title: 'Invalid Parameter Value' }] }, 400)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    await adapter.searchSongs(cred(), 'hello', 25).catch((e: unknown) => {
      expect(e).toBeInstanceOf(SearchError)
      expect((e as SearchError).retryable).toBe(false)
      expect((e as SearchError).rateLimited).toBe(false)
      expect((e as SearchError).message).toContain('(400)')
    })
  })

  it('搜索：429 限流归类为不可重试的限流错误', async () => {
    const { handler } = makeHandler((_method, url) => {
      if (url.pathname === '/v1/me/storefront') return json(STOREFRONT)
      return empty(429)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    await expect(adapter.searchSongs(cred(), '晴天', 10)).rejects.toThrow(SearchError)
    await adapter.searchSongs(cred(), '晴天', 10).catch((e: unknown) => {
      expect(e).toBeInstanceOf(SearchError)
      expect((e as SearchError).retryable).toBe(false)
      expect((e as SearchError).rateLimited).toBe(true)
    })
  })

  it('创建歌单：POST amp-api /v1/me/library/playlists，响应 data 数组取 id', async () => {
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('POST')
      expect(url.hostname).toBe('amp-api.music.apple.com')
      expect(url.pathname).toBe('/v1/me/library/playlists')
      expect(body).toEqual({ attributes: { name: '新歌单', isPublic: false } })
      return json({ data: [{ id: 'p.NEW1', type: 'library-playlists' }] }, 201)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const id = await adapter.createPlaylist(cred(), '新歌单')
    expect(id).toBe('p.NEW1')
    expect(calls[0].headers.get('content-type')).toBe('application/json')
  })

  it('添加歌曲：每批 ≤100 首，type 为 songs', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(1000 + i))
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('POST')
      expect(url.hostname).toBe('amp-api.music.apple.com')
      expect(url.pathname).toBe('/v1/me/library/playlists/p.ABC123/tracks')
      const data = (body as { data: Array<{ id: string; type: string }> }).data
      expect(data.length).toBeLessThanOrEqual(100)
      expect(data.every((d) => d.type === 'songs')).toBe(true)
      return empty(204)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    await adapter.addSongsToPlaylist(cred(), 'p.ABC123', ids)
    expect(calls).toHaveLength(2)
    expect((calls[0].body as { data: unknown[] }).data).toHaveLength(100)
    expect((calls[1].body as { data: unknown[] }).data).toHaveLength(1)
  })

  it('删除歌单：DELETE 必须走 amp-api 主机', async () => {
    const { handler, calls } = makeHandler((method, url) => {
      expect(method).toBe('DELETE')
      expect(url.hostname).toBe('amp-api.music.apple.com')
      expect(url.pathname).toBe('/v1/me/library/playlists/p.ABC123')
      return empty(204)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    await adapter.deletePlaylist(cred(), 'p.ABC123')
    expect(calls).toHaveLength(1)
  })

  it('重命名歌单：PATCH attributes.name', async () => {
    const { handler, calls } = makeHandler((method, url, body) => {
      expect(method).toBe('PATCH')
      expect(url.hostname).toBe('amp-api.music.apple.com')
      expect(body).toEqual({ attributes: { name: '新名字' } })
      return empty(204)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    await adapter.renamePlaylist(cred(), 'p.ABC123', '新名字')
    expect(calls).toHaveLength(1)
  })

  it('移除歌曲：官方 API 无端点，抛出用户可读的友好提示', async () => {
    const { handler } = makeHandler(() => empty(204))
    const adapter = new AppleMusicAdapter(handler, {})
    await expect(adapter.removeSongsFromPlaylist(cred(), 'p.ABC123', ['1'])).rejects.toThrow(
      'Apple Music暂不支持',
    )
  })

  it('扫码登录：明确报不支持', async () => {
    const { handler } = makeHandler(() => empty(200))
    const adapter = new AppleMusicAdapter(handler, {})
    await expect(adapter.createQrLogin()).rejects.toThrow('不支持扫码登录')
  })

  it('保活：developer token 过期时自动重抓并返回新凭证', async () => {
    const stale = cred({ devTokenAt: Date.now() - 61 * 24 * 60 * 60 * 1000 })
    const { handler } = makeHandler((_method, url) => {
      const page = webFrontResponder(url)
      if (page) return page
      if (url.pathname === '/v1/me/storefront') return json(STOREFRONT)
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const result = await adapter.keepAlive(stale)
    expect(result.alive).toBe(true)
    expect(result.cookie).toBeDefined()
    const refreshed = JSON.parse(result.cookie as string) as { developerToken: string }
    expect(refreshed.developerToken).toBe(WEB_TOKEN)
  })

  it('保活：403 凭证失效返回 alive=false（主进程据此下线）', async () => {
    const { handler } = makeHandler((_method, url) => {
      const page = webFrontResponder(url)
      if (page) return page
      return empty(403)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const result = await adapter.keepAlive(cred())
    expect(result).toEqual({ alive: false })
  })

  it('401：developer token 被回收时重抓一次并重试成功', async () => {
    let attempt = 0
    const { handler, calls } = makeHandler((_method, url) => {
      const page = webFrontResponder(url)
      if (page) return page
      if (url.pathname === '/v1/me/storefront') {
        attempt += 1
        return attempt === 1 ? empty(401) : json(STOREFRONT)
      }
      throw new Error(`unexpected request: ${url.href}`)
    })
    const adapter = new AppleMusicAdapter(handler, {})
    const account = await adapter.getLoginStatus(cred())
    expect(account?.userId).toBe('cn')
    // 401 后重试的第二次请求使用重抓后的 token
    const storefrontCalls = calls.filter((c) => c.url.pathname === '/v1/me/storefront')
    expect(storefrontCalls).toHaveLength(2)
    expect(storefrontCalls[1].headers.get('authorization')).toBe(`Bearer ${WEB_TOKEN}`)
  })

  it('凭证无效：抛明确错误', async () => {
    const { handler } = makeHandler(() => empty(200))
    const adapter = new AppleMusicAdapter(handler, {})
    await expect(adapter.getLoginStatus('not-json')).rejects.toThrow('登录凭证无效')
  })
})
