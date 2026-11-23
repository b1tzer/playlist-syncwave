import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import type { PlatformAdapter } from './base'
import type { HttpHandler } from './httpHandler'

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
    const res = await this.handle(request, this.env)
    const text = await res.text()
    let parsed: JsonObject = {}
    try {
      parsed = JSON.parse(text) as JsonObject
    } catch {
      // 非 JSON 响应按空处理
    }
    if (res.status >= 400 || (typeof parsed.code === 'number' && parsed.code >= 400)) {
      throw new Error(pickString(parsed.message, parsed.msg) ?? `QQ音乐请求失败 (${res.status})`)
    }
    return parsed
  }

  async createQrLogin(channel: string = 'qqmusic'): Promise<QrLoginTicket> {
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

    return { key, qrBase64 }
  }

  async checkQrLogin(key: string): Promise<QrLoginResult> {
    // 轮询接口的 session token 在 set-cookie 头返回，单独处理
    const url = new URL(`/login/qr/check?key=${encodeURIComponent(key)}`, 'http://local')
    const res = await this.handle(new Request(url, { method: 'GET' }), this.env)
    const body = asObject(JSON.parse((await res.text()) || '{}') as JsonObject)
    switch (body.code) {
      case 800:
        return { status: 'expired' }
      case 802:
        return { status: 'scanned' }
      case 803:
        return {
          status: 'success',
          cookie: extractSessionToken(res.headers.get('set-cookie')),
        }
      default:
        return { status: 'waiting' }
    }
  }

  async getLoginStatus(token: string): Promise<PlatformAccount | null> {
    const res = await this.call('GET', '/login/status', token)
    const profile = asObject(asObject(res.data).profile)
    const userId = pickString(profile.musicid, profile.str_musicid, profile.encryptUin)
    if (!userId) return null
    return {
      platform: this.platform,
      userId,
      nickname: pickString(profile.nickname, profile.nick) ?? '未知用户',
    }
  }

  async getUserPlaylists(token: string, userId: string): Promise<PlatformPlaylist[]> {
    const res = await this.call('GET', `/user/playlist?uid=${encodeURIComponent(userId)}`, token)
    const list = asArray(res.playlist)
    return list
      .map((p) => asObject(p))
      // dirId >= 200 是「我喜欢」收藏夹与收藏的他人歌单（与包内写入限制一致）
      .filter((item) => Number(item.dirId ?? 0) < 200)
      .map((item) => ({
        id: pickString(item.tid, item.id) ?? '',
        name: pickString(item.dirName, item.title, item.name) ?? '未命名歌单',
        songCount: Number(item.songNum ?? item.songCnt ?? item.song_count ?? 0),
        coverUrl: pickString(item.picUrl, item.coverUrl),
      }))
  }

  async getPlaylistSongs(token: string, playlistId: string): Promise<PlatformSong[]> {
    const res = await this.call(
      'GET',
      `/user/playlist-detail?tid=${encodeURIComponent(playlistId)}&limit=100`,
      token,
    )
    const songs = asArray(res.songs)
    return songs.map((s) => {
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
  }

  async searchSongs(token: string, keyword: string, limit = 30): Promise<PlatformSong[]> {
    const res = await this.call(
      'GET',
      `/search?keyword=${encodeURIComponent(keyword)}&type=song&limit=${limit}`,
      token,
    )
    const items = asArray(res.items)
    return items.map((s) => {
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
  }

  async createPlaylist(token: string, name: string): Promise<string> {
    const res = await this.call('POST', '/user/playlist/create', token, { name })
    const data = asObject(res.data)
    const id = pickString(data.tid, data.id)
    if (!id) throw new Error('QQ音乐：创建歌单失败')
    return id
  }

  async addSongsToPlaylist(token: string, playlistId: string, songIds: string[]): Promise<void> {
    if (songIds.length === 0) return
    // 接口限制每批最多 100 首
    for (let i = 0; i < songIds.length; i += 100) {
      const batch = songIds.slice(i, i + 100)
      const payload = {
        tid: Number(playlistId),
        op: 'add',
        songs: batch.map((id) => ({ id: Number(id), type: 0 })),
      }
      await this.call('POST', '/user/playlist/tracks', token, payload)
    }
  }
}
