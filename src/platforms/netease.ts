import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import type { PlatformAdapter } from './base'

/** NeteaseCloudMusicApi 的模块函数签名（CJS） */
export type NcmApiFn = (query?: Record<string, unknown>) => Promise<unknown>

export type NcmApi = Record<string, NcmApiFn>

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

function asStringArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** 将 NeteaseCloudMusicApi 的原始响应映射为领域模型 */
export class NeteaseAdapter implements PlatformAdapter {
  readonly platform = 'netease'

  constructor(private readonly api: NcmApi) {}

  async createQrLogin(): Promise<QrLoginTicket> {
    const keyRes = asObject(await this.api.login_qr_key!())
    const key = pickString(asObject(asObject(keyRes.body).data).unikey)
    if (!key) throw new Error('网易云：获取二维码 key 失败')

    const qrRes = asObject(await this.api.login_qr_create!({ key, qrimg: true }))
    const qrBase64 = pickString(asObject(asObject(qrRes.body).data).qrimg)
    if (!qrBase64) throw new Error('网易云：生成二维码失败')

    return { key, qrBase64 }
  }

  async checkQrLogin(key: string): Promise<QrLoginResult> {
    const res = asObject(await this.api.login_qr_check!({ key }))
    const code = asObject(res.body).code as number | undefined

    switch (code) {
      case 800:
        return { status: 'expired' }
      case 802:
        return { status: 'scanned' }
      case 803:
        return { status: 'success', cookie: pickString(asObject(res.body).cookie) }
      default:
        return { status: 'waiting' }
    }
  }

  async getLoginStatus(cookie: string): Promise<PlatformAccount | null> {
    const res = asObject(await this.api.login_status!({ cookie }))
    const data = asObject(asObject(res.body).data)
    const profile = asObject(data.profile)
    const account = asObject(data.account)
    const userId = pickString(account.id, profile.userId)
    if (!userId) return null
    return {
      platform: this.platform,
      userId,
      nickname: pickString(profile.nickname) ?? '未知用户',
    }
  }

  async getUserPlaylists(cookie: string, userId: string): Promise<PlatformPlaylist[]> {
    const res = asObject(await this.api.user_playlist!({ uid: userId, cookie }))
    const list = asObject(res.body).playlist
    if (!Array.isArray(list)) return []
    return list
      .map((p) => asObject(p))
      // 过滤收藏类特殊歌单：specialType=5 是「我喜欢的音乐」收藏夹
      .filter((item) => Number(item.specialType ?? 0) === 0)
      .map((item) => ({
        id: String(item.id),
        name: pickString(item.name) ?? '未命名歌单',
        songCount: Number(item.trackCount ?? item.track_count ?? 0),
        coverUrl: pickString(item.coverImgUrl),
      }))
  }

  async getPlaylistSongs(cookie: string, playlistId: string): Promise<PlatformSong[]> {
    const res = asObject(await this.api.playlist_detail!({ id: playlistId, cookie }))
    const tracks = asObject(asObject(res.body).playlist).tracks
    return asStringArray(tracks).map(mapTrack)
  }

  async searchSongs(cookie: string, keyword: string, limit = 30): Promise<PlatformSong[]> {
    let res: JsonObject
    try {
      res = asObject(
        await this.api.search!({ keywords: keyword, type: 1, limit, cookie }),
      )
    } catch (e) {
      // NCM 风格错误：{ status, body: { code, message } }
      const obj = asObject(e)
      const body = asObject(obj.body)
      const message = pickString(body.message, body.msg) ?? '搜索请求失败'
      const code = body.code !== undefined ? Number(body.code) : undefined
      // 405 操作频繁、5xx 网络错误可重试
      const retryable = code === 405 || code === undefined || code >= 500
      throw new SearchError(message, retryable)
    }
    const songs = asObject(asObject(res.body).result).songs
    return asStringArray(songs).map(mapTrack)
  }

  async createPlaylist(cookie: string, name: string): Promise<string> {
    const res = asObject(await this.api.playlist_create!({ name, privacy: '0', cookie }))
    const playlist = asObject(asObject(res.body).playlist)
    const id = pickString(playlist.id, asObject(res.body).id)
    if (!id) throw new Error('网易云：创建歌单失败')
    return id
  }

  async addSongsToPlaylist(cookie: string, playlistId: string, songIds: string[]): Promise<void> {
    if (songIds.length === 0) return
    const res = asObject(
      await this.api.playlist_track_add!({ op: 'add', pid: playlistId, ids: songIds.join(','), cookie }),
    )
    const body = asObject(res.body)
    if (body.code !== undefined && Number(body.code) !== 200) {
      throw new Error(`网易云：添加歌曲失败 code=${String(body.code)}`)
    }
  }
}

function mapTrack(t: unknown): PlatformSong {
  const item = asObject(t)
  const album = asObject(item.al ?? item.album)
  const artistList = asStringArray(item.ar ?? item.artists)
  return {
    id: String(item.id),
    title: pickString(item.name, item.title) ?? '未知歌曲',
    artist: artistList
      .map((a) => pickString(asObject(a).name))
      .filter((n): n is string => Boolean(n))
      .join(' / '),
    album: pickString(album.name),
    durationMs: typeof item.dt === 'number' ? item.dt : undefined,
  }
}
