import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type {
  PlatformPlaylist,
  PlatformSong,
} from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import { createLogger } from '@core/logging'
import type { PlatformModule } from '../meta'
import type { HttpHandler } from '../httpHandler'
import { BasePlatformAdapter, type LoginStatusRaw, type QrCheckRaw } from '../base'
import { artistNames, asArray, asObject, pickString, type JsonObject } from '../json'

const log = createLogger({ module: 'platform.qqmusic' })

/**
 * 提取歌曲封面：
 * 1. 优先条目里自带的直接 URL 字段；
 * 2. 其次用专辑 mid 拼 QQ 音乐公开图床（T002R500x500M000 = 专辑封面 500x500）。
 *    精简搜索/歌单详情的条目只有 albummid/album.mid 之类 mid，没有图片 URL；
 * 3. 都没有时退而求其次用歌曲 mid 拼歌曲图（部分歌曲无独立歌曲图，可能 404）。
 */
function coverOf(item: JsonObject, album: JsonObject): string | undefined {
  const direct = pickString(album.picUrl, album.albumPic, album.pic, item.albumPic, item.picUrl, item.coverUrl)
  if (direct) return direct
  const albumMid = pickString(
    item.albummid,
    item.album_mid,
    album.mid,
    album.albummid,
    album.pmid,
    item.pmid,
  )
  if (albumMid) return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
  const songMid = pickString(item.mid, item.songmid)
  if (songMid) return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${songMid}.jpg`
  return undefined
}

function extractSessionToken(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined
  const entry = setCookie.split(',').find((c) => c.includes('qqmusic_session='))
  if (!entry) return undefined
  return entry.split(';')[0]?.split('=')[1]?.trim() || undefined
}

/** QQ 音乐登录通道：qqmusic=QQ音乐App 扫码，wechat=微信扫码，qq=手机QQ扫码 */
export type QqLoginChannel = 'qqmusic' | 'wechat' | 'qq'

/**
 * QQ 音乐适配器：基于 @yakult-green-tea/qq-music-api（Node 模式本地服务或注入 handler）。
 * 仅实现平台差异原语（本地服务接口调用与字段映射），
 * 流程骨架（扫码状态机/耗时统计/统一日志）由 BasePlatformAdapter 模板方法提供。
 */
export class QqMusicAdapter extends BasePlatformAdapter {
  readonly platform = 'qqmusic'
  protected readonly platformLabel = 'QQ音乐'

  constructor(
    private readonly handle: HttpHandler,
    private readonly env: Record<string, string>,
  ) {
    super()
  }

  private async call(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<JsonObject> {
    const url = new URL(path, 'http://local')
    const headers: Record<string, string> = {}
    if (token) headers['x-qq-session'] = token
    const request = new Request(url, {
      method,
      headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const start = Date.now()
    const res = await this.handle(request, this.env)
    const text = await res.text()
    let parsed: JsonObject = {}
    try {
      parsed = JSON.parse(text) as JsonObject
    } catch {
      // 非 JSON 响应按空处理
    }
    const durationMs = Date.now() - start
    if (res.status >= 400 || (typeof parsed.code === 'number' && parsed.code >= 400)) {
      this.log.error(
        'http.call',
        'QQ音乐请求失败',
        undefined,
        { method, path, status: res.status, durationMs },
      )
      throw new Error(pickString(parsed.message, parsed.msg) ?? `QQ音乐请求失败 (${res.status})`)
    }
    this.log.debug('http.call', 'QQ音乐请求成功', { method, path, status: res.status, durationMs })
    return parsed
  }

  // --- 读原语 ---

  protected async qrCreateKey(channel: string = 'qqmusic'): Promise<string> {
    const keyRes = await this.call(
      'GET',
      `/login/qr/key?channel=${encodeURIComponent(channel)}`,
      '',
    )
    const key = pickString(asObject(keyRes.data).unikey)
    if (!key) throw new Error('QQ音乐：获取二维码 key 失败')
    return key
  }

  protected async qrBuildImage(key: string): Promise<string | undefined> {
    const qrRes = await this.call('GET', `/login/qr/create?key=${encodeURIComponent(key)}`, '')
    return pickString(asObject(qrRes.data).qrimg)
  }

  protected async qrCheckStatus(key: string): Promise<QrCheckRaw> {
    // 轮询接口的 session token 在 set-cookie 头返回，单独处理
    const url = new URL(`/login/qr/check?key=${encodeURIComponent(key)}`, 'http://local')
    const res = await this.handle(new Request(url, { method: 'GET' }), this.env)
    let body: JsonObject = {}
    try {
      body = asObject(JSON.parse((await res.text()) || '{}') as JsonObject)
    } catch {
      // 非 JSON 响应按空处理
    }
    return {
      code: body.code as number | undefined,
      cookie: extractSessionToken(res.headers.get('set-cookie')),
    }
  }

  protected async fetchLoginStatus(token: string): Promise<LoginStatusRaw> {
    const res = await this.call('GET', '/login/status', token)
    const profile = asObject(asObject(res.data).profile)
    // 昵称在 GetLoginUserInfo 的嵌套 info 对象里（顶层只有 credential 派生的 musicid/nick 等），
    // 微信等通道的 credential 不带 nick，必须从 info 里取
    const info = asObject(profile.info)
    return {
      userId: pickString(profile.musicid, profile.str_musicid, profile.encryptUin),
      nickname: pickString(profile.nickname, profile.nick, info.nickname, info.nick),
    }
  }

  protected async fetchPlaylists(token: string, userId: string): Promise<PlatformPlaylist[]> {
    const res = await this.call('GET', `/user/playlist?uid=${encodeURIComponent(userId)}`, token)
    const list = asArray(res.playlist)
    return list
      .map((p) => asObject(p))
      // dirId >= 200 是「我喜欢」收藏夹与收藏的他人歌单（与包内写入限制一致）
      .filter((item) => Number(item.dirId ?? 0) < 200)
      .map((item) => {
        const id = pickString(item.tid, item.id) ?? ''
        return {
          id,
          name: pickString(item.dirName, item.title, item.name) ?? '未命名歌单',
          songCount: Number(item.songNum ?? item.songCnt ?? item.song_count ?? 0),
          coverUrl: pickString(item.picUrl, item.coverUrl, item.pic),
          webUrl: `https://y.qq.com/n/ryqq/playlist/${id}`,
          appUrl: `qqmusic://qq.com/media/playSonglist?p=${id}`,
        }
      })
  }

  protected async fetchPlaylistSongs(token: string, playlistId: string): Promise<PlatformSong[]> {
    const rawItems: JsonObject[] = []
    const pageSize = 100
    // 接口支持 offset/limit 分页（limit 上限 100），逐页拉取直到 more=false，
    // 避免超过 100 首的歌单被截断。防御上限 50 页（5000 首），防止接口异常时无限循环。
    for (let page = 0; page < 50; page++) {
      const res = await this.call(
        'GET',
        `/user/playlist-detail?tid=${encodeURIComponent(playlistId)}&offset=${page * pageSize}&limit=${pageSize}`,
        token,
      )
      const songs = asArray(res.songs)
      rawItems.push(...songs.map((s) => asObject(s)))
      const total = typeof res.total === 'number' ? res.total : undefined
      const more = res.more === true || Number(res.more) === 1
      if (
        songs.length < pageSize ||
        (total !== undefined && rawItems.length >= total) ||
        !more
      ) {
        break
      }
    }
    return rawItems.map((item) => this.mapSong(item))
  }

  private mapSong(item: JsonObject): PlatformSong {
    return {
      id: pickString(item.songid, item.id, item.songmid) ?? '',
      title: pickString(item.songname, item.name, item.title) ?? '未知歌曲',
      artist: artistNames(asArray(item.singer ?? item.singers)),
      album: pickString(item.albumname, asObject(item.album).name),
      coverUrl: coverOf(item, asObject(item.album)),
      durationMs: typeof item.interval === 'number' ? item.interval * 1000 : undefined,
    }
  }

  protected async doSearch(
    token: string,
    keyword: string,
    limit: number,
    page = 1,
  ): Promise<PlatformSong[]> {
    try {
      return await this.searchRaw(token, keyword, limit, page)
    } catch (e) {
      // 平台错误分类：405 限流、5xx/网络错误可重试（判定逻辑归属平台适配器）
      const message = e instanceof Error ? e.message : '搜索请求失败'
      const statusMatch = message.match(/\((\d+)\)/)
      const status = statusMatch ? Number(statusMatch[1]) : undefined
      const rateLimited = status === 405
      const retryable = rateLimited || status === undefined || status >= 500
      this.log.warn('search.songs', '搜索请求失败', { keyword, status, retryable, message })
      throw new SearchError(message, retryable, rateLimited)
    }
  }

  private async searchRaw(
    token: string,
    keyword: string,
    limit: number,
    page: number,
  ): Promise<PlatformSong[]> {
    const res = await this.call(
      'GET',
      `/search?keyword=${encodeURIComponent(keyword)}&type=song&limit=${limit}&page=${page}`,
      token,
    )
    const items = asArray(res.items)
    return items.map((s) => {
      const item = asObject(s)
      const album = asObject(item.album)
      return {
        id: pickString(item.id, item.mid) ?? '',
        title: pickString(item.name, item.title) ?? '未知歌曲',
        artist: artistNames(asArray(item.singer)),
        album: pickString(album.name),
        coverUrl: coverOf(item, album),
        durationMs:
          typeof item.interval === 'number' ? item.interval * 1000 : undefined,
        genre: pickString(item.genre),
      }
    })
  }

  // --- 写原语 ---

  protected async doCreatePlaylist(token: string, name: string): Promise<string> {
    // QQ 音乐歌单名上限 20 个字符（按码点计），超长提前给出明确提示，避免撞上平台 400
    const trimmed = name.trim()
    if ([...trimmed].length > 20) {
      throw new Error('QQ音乐：歌单名最多 20 个字符，请缩短后重试')
    }
    const res = await this.call('POST', '/user/playlist/create', token, { name: trimmed })
    const data = asObject(res.data)
    // 3.3.5+ 新协议 tid 在响应顶层；旧协议在 data.tid/data.id，两者都兼容
    return pickString(res.tid, data.tid, data.id) ?? ''
  }

  protected async doAddSongs(token: string, playlistId: string, songIds: string[]): Promise<void> {
    await this.updatePlaylistTracks(token, playlistId, 'add', songIds, 'playlist.add-songs')
  }

  protected async doRemoveSongs(token: string, playlistId: string, songIds: string[]): Promise<void> {
    await this.updatePlaylistTracks(token, playlistId, 'del', songIds, 'playlist.remove-songs')
  }

  protected async doRenamePlaylist(token: string, playlistId: string, name: string): Promise<void> {
    await this.call('POST', '/user/playlist/rename', token, {
      tid: Number(playlistId),
      name,
    })
  }

  protected async doDeletePlaylist(token: string, playlistId: string): Promise<void> {
    await this.call('POST', '/user/playlist/delete', token, { tid: Number(playlistId) })
  }

  /** 歌曲批量增删共用的分批写入（接口限制每批 ≤100 首） */
  private async updatePlaylistTracks(
    token: string,
    playlistId: string,
    op: 'add' | 'del',
    songIds: string[],
    event: string,
  ): Promise<void> {
    for (let i = 0; i < songIds.length; i += 100) {
      const batch = songIds.slice(i, i + 100)
      const payload = {
        tid: Number(playlistId),
        op,
        songs: batch.map((id) => ({ id: Number(id), type: 0 })),
      }
      await this.call('POST', '/user/playlist/tracks', token, payload)
      this.log.debug(event, '写入一批歌曲', { playlistId, batch: batch.length })
    }
  }
}

/**
 * QQ 音乐登录态需要跨重启稳定：
 * - session 文件用 QQ_SESSION_SECRET 加密
 * - 设备身份（QIMEI 引导）保存在 QQ_AUTH_STATE_PATH
 * 全部放到 userData 目录。
 */
function loadSessionSecret(userDataDir: string): string {
  const file = join(userDataDir, 'qq-session-secret')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing.length >= 32) {
      log.debug('qqmusic.session-secret', '复用已有会话密钥')
      return existing
    }
  }
  const secret = randomBytes(32).toString('base64')
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, secret, 'utf-8')
  log.info('qqmusic.session-secret', '生成新的会话密钥')
  return secret
}

/** 找一个空闲的本地端口，避免 3200 被占用时起不来 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 3200
      srv.close(() => resolve(port))
    })
  })
}

/** QQ 音乐平台插件模块 */
const qqMusicModule: PlatformModule = {
  meta: {
    id: 'qqmusic',
    name: 'QQ音乐',
    icon: 'equalizer',
    capabilities: { read: true, write: true },
    loginChannels: [
      { id: 'qqmusic', label: 'QQ音乐 App 扫码' },
      { id: 'wechat', label: '微信扫码' },
      { id: 'qq', label: '手机QQ 扫码' },
    ],
  },
  createAdapter: async (ctx) => {
    mkdirSync(ctx.userDataDir, { recursive: true })
    const port = await findFreePort()
    log.info('qqmusic.service', '选择本地服务端口', { port })

    process.env['PORT'] = String(port)
    process.env['QQ_SESSION_SECRET'] = loadSessionSecret(ctx.userDataDir)
    process.env['QQ_AUTH_STATE_PATH'] = join(ctx.userDataDir, 'qq-device.json')
    process.env['QQ_AUTH_SESSION_PATH'] = join(ctx.userDataDir, 'qq-session.json')

    // 根模块加载副作用：启动 Koa 服务（MQTT 支持 qqmusic 通道）
    createRequire(import.meta.url)('@yakult-green-tea/qq-music-api')

    const baseUrl = `http://127.0.0.1:${port}`
    const handler: HttpHandler = async (request) => {
      const url = new URL(request.url)
      const target = `${baseUrl}${url.pathname}${url.search}`
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      }
      if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer()
      }
      return fetch(target, init)
    }

    log.info('qqmusic.service', '本地服务启动完成', { baseUrl })
    return new QqMusicAdapter(handler, {})
  },
}

export default qqMusicModule
