import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import { createLogger } from '@core/logging'
import type { PlatformAdapter } from '../base'
import type { HttpHandler } from '../httpHandler'
import type { PlatformModule } from '../meta'

const log = createLogger({ module: 'platform.qqmusic' })

type JsonObject = Record<string, unknown>

function asObject(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null ? (v as JsonObject) : {}
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function extractSessionToken(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined
  const entry = setCookie.split(',').find((c) => c.includes('qqmusic_session='))
  if (!entry) return undefined
  return entry.split(';')[0]?.split('=')[1]?.trim() || undefined
}

/** QQ 音乐登录通道：qqmusic=QQ音乐App 扫码，wechat=微信扫码，qq=手机QQ扫码 */
export type QqLoginChannel = 'qqmusic' | 'wechat' | 'qq'

/** QQ 音乐适配器：基于 @yakult-green-tea/qq-music-api（Node 模式本地服务或注入 handler） */
export class QqMusicAdapter implements PlatformAdapter {
  readonly platform = 'qqmusic'

  constructor(
    private readonly handle: HttpHandler,
    private readonly env: Record<string, string>,
  ) {}

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
      log.error(
        'http.call',
        'QQ音乐请求失败',
        undefined,
        { method, path, status: res.status, durationMs },
      )
      throw new Error(pickString(parsed.message, parsed.msg) ?? `QQ音乐请求失败 (${res.status})`)
    }
    log.debug('http.call', 'QQ音乐请求成功', { method, path, status: res.status, durationMs })
    return parsed
  }

  async createQrLogin(channel: string = 'qqmusic'): Promise<QrLoginTicket> {
    return log.time('login.qr.create', async () => {
      const keyRes = await this.call(
        'GET',
        `/login/qr/key?channel=${encodeURIComponent(channel)}`,
        '',
      )
      const key = pickString(asObject(keyRes.data).unikey)
      if (!key) throw new Error('QQ音乐：获取二维码 key 失败')

      const qrRes = await this.call('GET', `/login/qr/create?key=${encodeURIComponent(key)}`, '')
      const qrBase64 = pickString(asObject(qrRes.data).qrimg)
      if (!qrBase64) throw new Error('QQ音乐：生成二维码失败')

      log.info('login.qr.create', '二维码票据生成成功', { key, channel })
      return { key, qrBase64 }
    })
  }

  async checkQrLogin(key: string): Promise<QrLoginResult> {
    // 轮询接口高频调用，完成日志降为 debug，仅在状态变化时记录 info/warn
    return log.time(
      'login.qr.check',
      async () => {
        // 轮询接口的 session token 在 set-cookie 头返回，单独处理
        const url = new URL(`/login/qr/check?key=${encodeURIComponent(key)}`, 'http://local')
        const res = await this.handle(new Request(url, { method: 'GET' }), this.env)
        const body = asObject(JSON.parse((await res.text()) || '{}') as JsonObject)
        switch (body.code) {
          case 800:
            log.warn('login.qr.check', '二维码已过期', { key })
            return { status: 'expired' }
          case 802:
            return { status: 'scanned' }
          case 803:
            log.info('login.qr.check', '扫码确认成功', { key })
            return {
              status: 'success',
              cookie: extractSessionToken(res.headers.get('set-cookie')),
            }
          default:
            return { status: 'waiting' }
        }
      },
      undefined,
      'debug',
    )
  }

  async getLoginStatus(token: string): Promise<PlatformAccount | null> {
    return log.time('login.status', async () => {
      const res = await this.call('GET', '/login/status', token)
      const profile = asObject(asObject(res.data).profile)
      const userId = pickString(profile.musicid, profile.str_musicid, profile.encryptUin)
      if (!userId) return null
      const nickname = pickString(profile.nickname, profile.nick) ?? '未知用户'
      log.debug('login.status', '查询登录状态', { userId, nickname })
      return {
        platform: this.platform,
        userId,
        nickname,
      }
    })
  }

  async getUserPlaylists(token: string, userId: string): Promise<PlatformPlaylist[]> {
    return log.time('playlist.list', async () => {
      const res = await this.call('GET', `/user/playlist?uid=${encodeURIComponent(userId)}`, token)
      const list = asArray(res.playlist)
      const playlists = list
        .map((p) => asObject(p))
        // dirId >= 200 是「我喜欢」收藏夹与收藏的他人歌单（与包内写入限制一致）
        .filter((item) => Number(item.dirId ?? 0) < 200)
        .map((item) => ({
          id: pickString(item.tid, item.id) ?? '',
          name: pickString(item.dirName, item.title, item.name) ?? '未命名歌单',
          songCount: Number(item.songNum ?? item.songCnt ?? item.song_count ?? 0),
          coverUrl: pickString(item.picUrl, item.coverUrl),
        }))
      log.info('playlist.list', '拉取歌单列表', { userId, count: playlists.length })
      return playlists
    })
  }

  async getPlaylistSongs(token: string, playlistId: string): Promise<PlatformSong[]> {
    return log.time('playlist.songs', async () => {
      const res = await this.call(
        'GET',
        `/user/playlist-detail?tid=${encodeURIComponent(playlistId)}&limit=100`,
        token,
      )
      const songs = asArray(res.songs)
      const mapped = songs.map((s) => {
        const item = asObject(s)
        const singers = asArray(item.singer ?? item.singers)
        return {
          id: pickString(item.songid, item.id, item.songmid) ?? '',
          title: pickString(item.songname, item.name, item.title) ?? '未知歌曲',
          artist: singers
            .map((x) => pickString(asObject(x).name))
            .filter((n): n is string => Boolean(n))
            .join(' / '),
          album: pickString(item.albumname, asObject(item.album).name),
          durationMs:
            typeof item.interval === 'number' ? item.interval * 1000 : undefined,
        }
      })
      log.info('playlist.songs', '拉取歌单歌曲', { playlistId, count: mapped.length })
      return mapped
    })
  }

  async searchSongs(token: string, keyword: string, limit = 30): Promise<PlatformSong[]> {
    // 同步过程中逐首高频调用，完成日志降为 debug
    return log.time('search.songs', async () => {
      const res = await this.call(
        'GET',
        `/search?keyword=${encodeURIComponent(keyword)}&type=song&limit=${limit}`,
        token,
      )
      const items = asArray(res.items)
      const mapped = items.map((s) => {
        const item = asObject(s)
        const singers = asArray(item.singer)
        return {
          id: pickString(item.id, item.mid) ?? '',
          title: pickString(item.name, item.title) ?? '未知歌曲',
          artist: singers
            .map((x) => pickString(asObject(x).name))
            .filter((n): n is string => Boolean(n))
            .join(' / '),
          album: pickString(asObject(item.album).name),
          durationMs:
            typeof item.interval === 'number' ? item.interval * 1000 : undefined,
        }
      })
      log.debug('search.songs', '搜索结果', { keyword, count: mapped.length })
      return mapped
    }, undefined, 'debug')
  }

  async createPlaylist(token: string, name: string): Promise<string> {
    return log.time('playlist.create', async () => {
      const res = await this.call('POST', '/user/playlist/create', token, { name })
      const data = asObject(res.data)
      const id = pickString(data.tid, data.id)
      if (!id) throw new Error('QQ音乐：创建歌单失败')
      log.info('playlist.create', '创建歌单成功', { playlistId: id, name })
      return id
    })
  }

  async addSongsToPlaylist(token: string, playlistId: string, songIds: string[]): Promise<void> {
    return log.time('playlist.add-songs', async () => {
      if (songIds.length === 0) return
      // 接口限制每批最多 100 首
      let added = 0
      for (let i = 0; i < songIds.length; i += 100) {
        const batch = songIds.slice(i, i + 100)
        const payload = {
          tid: Number(playlistId),
          op: 'add',
          songs: batch.map((id) => ({ id: Number(id), type: 0 })),
        }
        await this.call('POST', '/user/playlist/tracks', token, payload)
        added += batch.length
        log.debug('playlist.add-songs', '写入一批歌曲', { playlistId, batch: batch.length })
      }
      log.info('playlist.add-songs', '批量添加歌曲成功', { playlistId, count: added })
    })
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
    apiLabel: 'QQ Music API: Node Mode (Direct)',
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
