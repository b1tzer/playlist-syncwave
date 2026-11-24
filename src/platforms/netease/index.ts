import { createRequire } from 'node:module'
import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import { createLogger } from '@core/logging'
import type { PlatformAdapter } from '../base'
import type { PlatformModule } from '../meta'

const log = createLogger({ module: 'platform.netease' })

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

  async createQrLogin(_channel?: string): Promise<QrLoginTicket> {
    return log.time('login.qr.create', async () => {
      const keyRes = asObject(await this.api.login_qr_key!())
      const key = pickString(asObject(asObject(keyRes.body).data).unikey)
      if (!key) throw new Error('网易云：获取二维码 key 失败')

      const qrRes = asObject(await this.api.login_qr_create!({ key, qrimg: true }))
      const qrBase64 = pickString(asObject(asObject(qrRes.body).data).qrimg)
      if (!qrBase64) throw new Error('网易云：生成二维码失败')

      log.info('login.qr.create', '二维码票据生成成功', { key })
      return { key, qrBase64 }
    })
  }

  async checkQrLogin(key: string): Promise<QrLoginResult> {
    // 轮询接口高频调用，完成日志降为 debug，仅在状态变化时记录 info/warn
    return log.time(
      'login.qr.check',
      async () => {
        const res = asObject(await this.api.login_qr_check!({ key }))
        const code = asObject(res.body).code as number | undefined

        switch (code) {
          case 800:
            log.warn('login.qr.check', '二维码已过期', { key })
            return { status: 'expired' }
          case 802:
            return { status: 'scanned' }
          case 803:
            log.info('login.qr.check', '扫码确认成功', { key })
            return { status: 'success', cookie: pickString(asObject(res.body).cookie) }
          default:
            return { status: 'waiting' }
        }
      },
      undefined,
      'debug',
    )
  }

  async getLoginStatus(cookie: string): Promise<PlatformAccount | null> {
    return log.time('login.status', async () => {
      const res = asObject(await this.api.login_status!({ cookie }))
      const data = asObject(asObject(res.body).data)
      const profile = asObject(data.profile)
      const account = asObject(data.account)
      const userId = pickString(account.id, profile.userId)
      if (!userId) return null
      const nickname = pickString(profile.nickname) ?? '未知用户'
      log.debug('login.status', '查询登录状态', { userId, nickname })
      return {
        platform: this.platform,
        userId,
        nickname,
      }
    })
  }

  async getUserPlaylists(cookie: string, userId: string): Promise<PlatformPlaylist[]> {
    return log.time('playlist.list', async () => {
      const res = asObject(await this.api.user_playlist!({ uid: userId, cookie }))
      const list = asObject(res.body).playlist
      if (!Array.isArray(list)) return []
      const playlists = list
        .map((p) => asObject(p))
        // 过滤收藏类特殊歌单：specialType=5 是「我喜欢的音乐」收藏夹
        .filter((item) => Number(item.specialType ?? 0) === 0)
        .map((item) => ({
          id: String(item.id),
          name: pickString(item.name) ?? '未命名歌单',
          songCount: Number(item.trackCount ?? item.track_count ?? 0),
          coverUrl: pickString(item.coverImgUrl),
        }))
      log.info('playlist.list', '拉取歌单列表', { userId, count: playlists.length })
      return playlists
    })
  }

  async getPlaylistSongs(cookie: string, playlistId: string): Promise<PlatformSong[]> {
    return log.time('playlist.songs', async () => {
      const res = asObject(await this.api.playlist_detail!({ id: playlistId, cookie }))
      const tracks = asObject(asObject(res.body).playlist).tracks
      const songs = asStringArray(tracks).map(mapTrack)
      log.info('playlist.songs', '拉取歌单歌曲', { playlistId, count: songs.length })
      return songs
    })
  }

  async searchSongs(cookie: string, keyword: string, limit = 30): Promise<PlatformSong[]> {
    // 同步过程中逐首高频调用，完成日志降为 debug
    return log.time('search.songs', async () => {
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
        log.warn('search.songs', '搜索请求失败', { keyword, code, retryable, message })
        throw new SearchError(message, retryable)
      }
      const songs = asObject(asObject(res.body).result).songs
      const mapped = asStringArray(songs).map(mapTrack)
      log.debug('search.songs', '搜索结果', { keyword, count: mapped.length })
      return mapped
    }, undefined, 'debug')
  }

  async createPlaylist(cookie: string, name: string): Promise<string> {
    return log.time('playlist.create', async () => {
      const res = asObject(await this.api.playlist_create!({ name, privacy: '0', cookie }))
      const playlist = asObject(asObject(res.body).playlist)
      const id = pickString(playlist.id, asObject(res.body).id)
      if (!id) throw new Error('网易云：创建歌单失败')
      log.info('playlist.create', '创建歌单成功', { playlistId: id, name })
      return id
    })
  }

  async addSongsToPlaylist(cookie: string, playlistId: string, songIds: string[]): Promise<void> {
    return log.time('playlist.add-songs', async () => {
      if (songIds.length === 0) return
      const res = asObject(
        await this.api.playlist_track_add!({ op: 'add', pid: playlistId, ids: songIds.join(','), cookie }),
      )
      const body = asObject(res.body)
      if (body.code !== undefined && Number(body.code) !== 200) {
        throw new Error(`网易云：添加歌曲失败 code=${String(body.code)}`)
      }
      log.info('playlist.add-songs', '批量添加歌曲成功', { playlistId, count: songIds.length })
    })
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

/** 网易云音乐平台插件模块 */
const neteaseModule: PlatformModule = {
  meta: {
    id: 'netease',
    name: '网易云音乐',
    apiLabel: 'Netease API Gateway: v3.12 (Direct)',
    icon: 'graphic_eq',
    capabilities: { read: true, write: true },
  },
  createAdapter: () => {
    // 重依赖懒加载：测试环境 import 本模块不会触发 require
    const ncm = createRequire(import.meta.url)('NeteaseCloudMusicApi') as NcmApi
    return new NeteaseAdapter(ncm)
  },
}

export default neteaseModule
