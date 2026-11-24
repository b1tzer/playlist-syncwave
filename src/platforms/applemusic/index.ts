import type {
  PlatformPlaylist,
  PlatformSong,
} from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import type { PlatformModule } from '../meta'
import type { HttpHandler } from '../httpHandler'
import {
  BasePlatformAdapter,
  type KeepAliveResult,
  type LoginStatusRaw,
  type QrCheckRaw,
} from '../base'
import { asArray, asObject, pickString, type JsonObject } from '../json'

/** 读接口根地址（官方主机） */
const API_HOST = 'https://api.music.apple.com'
/** 写接口根地址（实测：删除类操作在官方主机固定 401，必须走 amp-api，写操作统一使用） */
const WRITE_HOST = 'https://amp-api.music.apple.com'
/** 网页前端 developer token 的来源页 */
const WEB_INDEX_URL = 'https://music.apple.com/cn/browse'

/**
 * developer token 有效期实测约 70 天。
 * 提前到 60 天即视为过期重抓，避免到期前恰好无法访问网络。
 */
const DEV_TOKEN_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

/** 网页请求 UA：社区路径从网页前端提取 token，伪装浏览器 UA 避免被拦 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 凭证结构（JSON 字符串，整体存入通用加密凭证库，主进程不解析内容） */
interface AppleCredential {
  /** 用户会话 token（media-user-token，约 6 个月有效） */
  mediaUserToken: string
  /** 网页前端公开 developer token（约 70 天有效，过期自动重抓） */
  developerToken: string
  /** developer token 抓取时间（epoch ms），用于过期判定 */
  devTokenAt: number
}

function parseCredential(credential: string): AppleCredential {
  try {
    const obj = asObject(JSON.parse(credential) as unknown)
    const mediaUserToken = pickString(obj.mediaUserToken)
    const developerToken = pickString(obj.developerToken)
    if (!mediaUserToken || !developerToken) throw new Error()
    return {
      mediaUserToken,
      developerToken,
      devTokenAt: Number(obj.devTokenAt) || 0,
    }
  } catch {
    throw new Error('Apple Music：登录凭证无效，请重新登录')
  }
}

function serializeCredential(c: AppleCredential): string {
  return JSON.stringify({
    v: 1,
    mediaUserToken: c.mediaUserToken,
    developerToken: c.developerToken,
    devTokenAt: c.devTokenAt,
  })
}

/** 凭证失效错误：403 表示用户 token 失效，401 表示 developer token 问题（可重抓） */
class AppleAuthError extends Error {
  constructor(
    message: string,
    readonly authExpired: boolean,
  ) {
    super(message)
    this.name = 'AppleAuthError'
  }
}

/** 封面 artwork 模板 URL → 300x300 实际地址 */
function artworkUrl(artwork: unknown): string | undefined {
  const url = pickString(asObject(artwork).url)
  if (!url) return undefined
  return url.replace('{w}', '300').replace('{h}', '300')
}

/**
 * Apple Music 适配器（社区路径）：
 * - developer token 从 music.apple.com 网页前端 bundle 提取（iss=AMPWebPlay 公开 token）
 * - 用户凭证为 media-user-token（登录后写入浏览器 cookie，由主进程登录窗口提取）
 * - 读接口走官方主机，写接口走 amp-api（实测结论）
 *
 * 流程骨架（日志/耗时统计）由 BasePlatformAdapter 模板方法提供，
 * 本类仅实现平台差异原语与字段映射。
 */
export class AppleMusicAdapter extends BasePlatformAdapter {
  readonly platform = 'applemusic'
  protected readonly platformLabel = 'Apple Music'

  /** 重抓的 developer token 实例级缓存（跨凭证续期复用，避免频繁抓取） */
  private devTokenCache: { token: string; at: number } | null = null
  /** 用户 storefront（如 cn），登录态校验时刷新，搜索接口使用 */
  private storefront: string | undefined

  constructor(
    private readonly handle: HttpHandler,
    private readonly env: Record<string, string>,
  ) {
    super()
  }

  // ==============================
  // 扫码登录：Apple Music 无扫码接口，直接不支持
  // ==============================

  override async createQrLogin(_channel?: string): Promise<never> {
    throw new Error('Apple Music 不支持扫码登录，请使用网页登录')
  }

  override async checkQrLogin(_key: string): Promise<never> {
    throw new Error('Apple Music 不支持扫码登录，请使用网页登录')
  }

  protected async qrCreateKey(_channel?: string): Promise<string> {
    throw new Error('Apple Music 不支持扫码登录，请使用网页登录')
  }

  protected async qrBuildImage(_key: string): Promise<string | undefined> {
    throw new Error('Apple Music 不支持扫码登录，请使用网页登录')
  }

  protected async qrCheckStatus(_key: string): Promise<QrCheckRaw> {
    throw new Error('Apple Music 不支持扫码登录，请使用网页登录')
  }

  // ==============================
  // 网页登录凭证构造：拿 media-user-token 换完整凭证
  // ==============================

  async webLoginSetup(sessionValue: string): Promise<string> {
    const developerToken = await this.fetchWebDeveloperToken()
    const at = Date.now()
    this.devTokenCache = { token: developerToken, at }
    return serializeCredential({
      mediaUserToken: sessionValue,
      developerToken,
      devTokenAt: at,
    })
  }

  // ==============================
  // HTTP 调用
  // ==============================

  /**
   * 统一调用：自动保证 developer token 有效期（过期重抓），
   * 401 时重抓一次重试（网页 token 可能被提前回收），403 抛凭证失效。
   */
  private async call(
    method: string,
    host: string,
    path: string,
    credential: string,
    body?: unknown,
  ): Promise<JsonObject> {
    let current = await this.ensureDeveloperToken(credential)
    let res = await this.rawCall(method, host, path, current, body)
    if (res.status === 401) {
      // developer token 可能被提前回收：强制重抓一次后重试
      const token = await this.fetchWebDeveloperToken()
      const at = Date.now()
      this.devTokenCache = { token, at }
      const parsed = parseCredential(current.credential)
      current = {
        credential: serializeCredential({ ...parsed, developerToken: token, devTokenAt: at }),
        developerToken: token,
      }
      res = await this.rawCall(method, host, path, current, body)
    }
    const text = await res.text()
    let parsed: JsonObject = {}
    if (text) {
      try {
        parsed = asObject(JSON.parse(text) as unknown)
      } catch {
        // 非 JSON 响应按空处理
      }
    }
    if (res.status >= 400) {
      const firstError = asObject(asArray(parsed.errors)[0])
      if (res.status === 403) {
        const code = pickString(firstError.code)
        throw new AppleAuthError(
          `Apple Music：登录已失效${code ? `（${code}）` : ''}，请重新登录`,
          true,
        )
      }
      if (res.status === 429) {
        throw new SearchError('Apple Music：请求过于频繁，请稍后再试', false, true)
      }
      throw new Error(
        pickString(firstError.title, firstError.detail) ??
          `Apple Music：请求失败 (${res.status})`,
      )
    }
    return parsed
  }

  private async rawCall(
    method: string,
    host: string,
    path: string,
    auth: { credential: string; developerToken: string },
    body?: unknown,
  ): Promise<Response> {
    const url = `${host}${path}`
    const { mediaUserToken } = parseCredential(auth.credential)
    const headers: Record<string, string> = {
      authorization: `Bearer ${auth.developerToken}`,
      origin: 'https://music.apple.com',
      'user-agent': BROWSER_UA,
    }
    // 仅个人库端点需要用户 token
    if (path.startsWith('/v1/me/')) headers['music-user-token'] = mediaUserToken
    const request = new Request(url, {
      method,
      headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const start = Date.now()
    const res = await this.handle(request, this.env)
    this.log.debug('http.call', 'Apple Music 请求', {
      method,
      path,
      status: res.status,
      durationMs: Date.now() - start,
    })
    return res
  }

  /** 保证 developer token 在有效期内；重抓后返回更新过的凭证串（由保活持久化） */
  private async ensureDeveloperToken(
    credential: string,
  ): Promise<{ credential: string; developerToken: string }> {
    const parsed = parseCredential(credential)
    const age = Date.now() - parsed.devTokenAt
    if (age < DEV_TOKEN_MAX_AGE_MS) {
      return { credential, developerToken: parsed.developerToken }
    }
    if (this.devTokenCache && Date.now() - this.devTokenCache.at < DEV_TOKEN_MAX_AGE_MS) {
      const updated = serializeCredential({
        ...parsed,
        developerToken: this.devTokenCache.token,
        devTokenAt: this.devTokenCache.at,
      })
      return { credential: updated, developerToken: this.devTokenCache.token }
    }
    const token = await this.fetchWebDeveloperToken()
    const at = Date.now()
    this.devTokenCache = { token, at }
    return {
      credential: serializeCredential({ ...parsed, developerToken: token, devTokenAt: at }),
      developerToken: token,
    }
  }

  /** 社区路径核心：从 music.apple.com 网页前端 bundle 提取公开 developer token */
  private async fetchWebDeveloperToken(): Promise<string> {
    const pageRes = await this.handle(
      new Request(WEB_INDEX_URL, { headers: { 'user-agent': BROWSER_UA } }),
      this.env,
    )
    const html = await pageRes.text()
    const bundleMatch = html.match(/\/assets\/index[^"']*\.js/)
    if (!bundleMatch) {
      throw new Error('Apple Music：无法定位网页前端资源入口，请稍后重试')
    }
    const bundleUrl = new URL(bundleMatch[0], 'https://music.apple.com').href
    const jsRes = await this.handle(
      new Request(bundleUrl, { headers: { 'user-agent': BROWSER_UA } }),
      this.env,
    )
    const js = await jsRes.text()
    // JWT 形如 eyJ....eyJ....sig，遍历全部候选，验证 payload.iss
    const re = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
    let match: RegExpExecArray | null
    while ((match = re.exec(js))) {
      const token = match[0]
      try {
        const payloadText = Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8')
        const payload = asObject(JSON.parse(payloadText) as unknown)
        if (payload.iss === 'AMPWebPlay') {
          this.log.info('login.dev-token', '已从网页前端提取 developer token')
          return token
        }
      } catch {
        // 非法候选跳过
      }
    }
    throw new Error('Apple Music：网页前端未找到可用凭证，可能结构已变更，请稍后重试')
  }

  // ==============================
  // 读原语
  // ==============================

  protected async fetchLoginStatus(credential: string): Promise<LoginStatusRaw> {
    try {
      const res = await this.call('GET', API_HOST, '/v1/me/storefront', credential)
      const storefrontId = pickString(asObject(asArray(res.data)[0]).id)
      if (!storefrontId) return {}
      this.storefront = storefrontId
      return { userId: storefrontId, nickname: 'Apple Music 用户' }
    } catch (e) {
      // 用户 token 失效按未登录处理（主进程据此显示未登录态）；网络异常继续上抛
      if (e instanceof AppleAuthError) {
        this.log.warn('login.status', '登录态校验失败', { message: e.message })
        return {}
      }
      throw e
    }
  }

  protected async doKeepAlive(credential: string): Promise<KeepAliveResult> {
    try {
      const fresh = await this.ensureDeveloperToken(credential)
      await this.call('GET', API_HOST, '/v1/me/storefront', fresh.credential)
      // developer token 发生过重抓时传回新凭证，主进程持久化
      if (fresh.credential !== credential) {
        this.log.info('keepalive.check', 'developer token 已更新，凭证续期')
        return { alive: true, cookie: fresh.credential }
      }
      return { alive: true }
    } catch (e) {
      // 用户 token 失效：明确下线；网络异常等由模板方法兜底保持现状
      if (e instanceof AppleAuthError && e.authExpired) return { alive: false }
      throw e
    }
  }

  protected async fetchPlaylists(
    credential: string,
    _userId: string,
  ): Promise<PlatformPlaylist[]> {
    const items: JsonObject[] = []
    let next: string | undefined = '/v1/me/library/playlists?limit=100&offset=0'
    // 防御上限 50 页（5000 个歌单），避免异常时无限循环
    for (let page = 0; page < 50 && next; page++) {
      const res = await this.call('GET', API_HOST, next, credential)
      items.push(...asArray(res.data).map((p) => asObject(p)))
      // next 已带 /v1 前缀，直接拼 host 使用
      next = pickString(res.next)
      if (!next || asArray(res.data).length === 0) break
    }
    return items.map((item) => {
      const attrs = asObject(item.attributes)
      const id = pickString(item.id) ?? ''
      return {
        id,
        name: pickString(attrs.name) ?? '未命名歌单',
        songCount: Number(attrs.trackCount) || 0,
        coverUrl: artworkUrl(attrs.artwork),
        webUrl: `https://music.apple.com/library/playlist/${id}`,
      }
    })
  }

  protected async fetchPlaylistSongs(
    credential: string,
    playlistId: string,
  ): Promise<PlatformSong[]> {
    const items: JsonObject[] = []
    let next: string | undefined = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`
    // 防御上限 100 页（10000 首），避免异常时无限循环
    for (let page = 0; page < 100 && next; page++) {
      const res = await this.call('GET', API_HOST, next, credential)
      items.push(...asArray(res.data).map((s) => asObject(s)))
      next = pickString(res.next)
      if (!next || asArray(res.data).length === 0) break
    }
    return items.map(mapSong)
  }

  protected async doSearch(
    credential: string,
    keyword: string,
    limit: number,
  ): Promise<PlatformSong[]> {
    // 实测：整串带 " - " 搜索会大量命中 Live 版，拆成空格分隔显著改善
    const term = keyword.replace(/\s*-\s*/g, ' ').trim()
    const storefront = await this.ensureStorefront(credential)
    try {
      const res = await this.call(
        'GET',
        API_HOST,
        `/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(term)}&types=songs&limit=${limit}`,
        credential,
      )
      const results = asObject(res.results)
      const songs = asArray(asObject(results.songs).data ?? results.songs)
      return songs.map((s) => mapSong(asObject(s)))
    } catch (e) {
      if (e instanceof SearchError) throw e
      if (e instanceof AppleAuthError) {
        throw new SearchError(e.message, false, false)
      }
      const message = e instanceof Error ? e.message : '搜索请求失败'
      const statusMatch = message.match(/\((\d+)\)/)
      const status = statusMatch ? Number(statusMatch[1]) : undefined
      const retryable = status === undefined || status >= 500
      this.log.warn('search.songs', '搜索请求失败', { keyword: term, status, retryable, message })
      throw new SearchError(message, retryable, status === 429)
    }
  }

  /** 获取用户 storefront（内存缓存，登录态校验时已刷新） */
  private async ensureStorefront(credential: string): Promise<string> {
    if (!this.storefront) {
      const raw = await this.fetchLoginStatus(credential)
      if (!raw.userId) throw new Error('Apple Music：登录已失效，请重新登录')
    }
    return this.storefront ?? 'cn'
  }

  // ==============================
  // 写原语（统一走 amp-api，实测结论）
  // ==============================

  protected async doCreatePlaylist(credential: string, name: string): Promise<string> {
    const res = await this.call('POST', WRITE_HOST, '/v1/me/library/playlists', credential, {
      attributes: { name, isPublic: false },
    })
    // 写响应 data 为数组：[{ id: 'p.xxx', ... }]
    const id = pickString(asObject(asArray(res.data)[0]).id)
    if (!id) throw new Error('Apple Music：创建歌单失败')
    return id
  }

  protected async doAddSongs(
    credential: string,
    playlistId: string,
    songIds: string[],
  ): Promise<void> {
    // 建单/加曲单次上限 100 首（契约速查结论），分批写入
    for (let i = 0; i < songIds.length; i += 100) {
      const batch = songIds.slice(i, i + 100)
      await this.withPlaylistReadyRetry(() =>
        this.call(
          'POST',
          WRITE_HOST,
          `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`,
          credential,
          { data: batch.map((id) => ({ id, type: 'songs' })) },
        ),
      )
      this.log.debug('playlist.add-songs', '写入一批歌曲', { playlistId, batch: batch.length })
    }
  }

  /** 新建歌单 iCloud 传播有几秒到几十秒延迟：404 时等 1.5s 重试一次 */
  private async withPlaylistReadyRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      if (message.includes('(404)')) {
        this.log.debug('playlist.add-songs', '歌单尚未就绪，1.5s 后重试', { message })
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return fn()
      }
      throw e
    }
  }

  protected async doRenamePlaylist(
    credential: string,
    playlistId: string,
    name: string,
  ): Promise<void> {
    // 社区实测改名返回 204；请求体为 PATCH attributes.name
    await this.call(
      'PATCH',
      WRITE_HOST,
      `/v1/me/library/playlists/${encodeURIComponent(playlistId)}`,
      credential,
      { attributes: { name } },
    )
  }

  protected async doDeletePlaylist(credential: string, playlistId: string): Promise<void> {
    // 实测：删除在官方主机固定 401，必须走 amp-api
    await this.call(
      'DELETE',
      WRITE_HOST,
      `/v1/me/library/playlists/${encodeURIComponent(playlistId)}`,
      credential,
    )
  }

  // 移除歌曲：官方 API 未提供端点，保持基类默认「不支持」
}

function mapSong(item: JsonObject): PlatformSong {
  const attrs = asObject(item.attributes)
  const playParams = asObject(attrs.playParams)
  return {
    // 歌单内条目优先用 catalog id（可跨端写入）；无 catalog id 时退回条目 id
    id: pickString(playParams.catalogId, item.id) ?? '',
    title: pickString(attrs.name) ?? '未知歌曲',
    artist: pickString(attrs.artistName) ?? '',
    album: pickString(attrs.albumName),
    coverUrl: artworkUrl(attrs.artwork),
    durationMs:
      typeof attrs.durationInMillis === 'number' ? attrs.durationInMillis : undefined,
    genre: pickString(asArray(attrs.genreNames)[0]),
  }
}

/** Apple Music 平台插件模块（社区路径：网页前端 token + 登录 cookie） */
const appleMusicModule: PlatformModule = {
  meta: {
    id: 'applemusic',
    name: 'Apple Music',
    apiLabel: 'Apple Music Web API (Community)',
    icon: 'library_music',
    capabilities: { read: true, write: true },
    loginType: 'web',
    webLogin: {
      url: WEB_INDEX_URL,
      cookieName: 'media-user-token',
      cookieUrl: 'https://music.apple.com',
    },
  },
  createAdapter: () => {
    // 平台模块不依赖 electron：主进程 fetch 转发为注入的 HttpHandler，测试可替换
    const handler: HttpHandler = async (request) => {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      }
      if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer()
      }
      return fetch(request.url, init)
    }
    return new AppleMusicAdapter(handler, {})
  },
}

export default appleMusicModule
