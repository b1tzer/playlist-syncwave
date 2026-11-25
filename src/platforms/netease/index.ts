import { createRequire } from 'node:module'
import type {
  PlatformPlaylist,
  PlatformSong,
} from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import type { PlatformModule } from '../meta'
import {
  BasePlatformAdapter,
  type KeepAliveResult,
  type LoginStatusRaw,
  type QrCheckRaw,
} from '../base'
import { artistNames, asArray, asObject, pickString, type JsonObject } from '../json'

/** NeteaseCloudMusicApi 的模块函数签名（CJS） */
export type NcmApiFn = (query?: Record<string, unknown>) => Promise<unknown>

export type NcmApi = Record<string, NcmApiFn>

/**
 * NCM 接口调用：将 NCM 风格对象异常（{ body: { code, message } }）
 * 转为带真实原因的 Error，避免错误原因被吞成 [object Object]。
 */
async function callNcm(fn: NcmApiFn, query?: Record<string, unknown>): Promise<unknown> {
  try {
    return await fn(query)
  } catch (e) {
    if (e instanceof Error) throw e
    const body = asObject(asObject(e).body)
    const code = body.code !== undefined ? Number(body.code) : undefined
    const message = pickString(body.message, body.msg) ?? '网易云接口请求失败'
    throw new Error(code !== undefined ? `网易云接口错误 code=${code}：${message}` : message)
  }
}

/**
 * 网易云适配器：基于 NeteaseCloudMusicApi。
 * 仅实现平台差异原语（接口调用与字段映射），
 * 流程骨架（扫码状态机/耗时统计/统一日志）由 BasePlatformAdapter 模板方法提供。
 */
export class NeteaseAdapter extends BasePlatformAdapter {
  readonly platform = 'netease'
  protected readonly platformLabel = '网易云'

  constructor(private readonly api: NcmApi) {
    super()
  }

  // --- 读原语 ---

  protected async qrCreateKey(_channel?: string): Promise<string> {
    const keyRes = asObject(await callNcm(this.api.login_qr_key!))
    const key = pickString(asObject(asObject(keyRes.body).data).unikey)
    if (!key) throw new Error('网易云：获取二维码 key 失败')
    return key
  }

  protected async qrBuildImage(key: string): Promise<string | undefined> {
    const qrRes = asObject(await callNcm(this.api.login_qr_create!, { key, qrimg: true }))
    return pickString(asObject(asObject(qrRes.body).data).qrimg)
  }

  protected async qrCheckStatus(key: string): Promise<QrCheckRaw> {
    const res = asObject(await callNcm(this.api.login_qr_check!, { key }))
    const body = asObject(res.body)
    return {
      code: body.code as number | undefined,
      cookie: pickString(body.cookie),
    }
  }

  protected async fetchLoginStatus(cookie: string): Promise<LoginStatusRaw> {
    const res = asObject(await callNcm(this.api.login_status!, { cookie }))
    const data = asObject(asObject(res.body).data)
    const profile = asObject(data.profile)
    const account = asObject(data.account)
    return {
      userId: pickString(account.id, profile.userId),
      nickname: pickString(profile.nickname),
    }
  }

  protected async doKeepAlive(cookie: string): Promise<KeepAliveResult> {
    // 优先走 login_refresh 续期；扫码登录无 refresh token 时接口报错，回退为登录态校验
    try {
      const res = asObject(await callNcm(this.api.login_refresh!, { cookie }))
      const refreshed = pickString(asObject(res.body).cookie)
      if (refreshed) return { alive: true, cookie: refreshed }
    } catch (e) {
      this.log.debug('keepalive.check', 'token 刷新不可用，回退为登录态校验', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
    const raw = await this.fetchLoginStatus(cookie)
    return { alive: Boolean(raw.userId) }
  }

  protected async fetchPlaylists(cookie: string, userId: string): Promise<PlatformPlaylist[]> {
    const raw: JsonObject[] = []
    const pageSize = 100
    // 接口默认 limit=30：必须显式分页拉取，否则超过 30 个歌单会被截断。
    // 防御上限 50 页（5000 个歌单），避免接口异常时无限循环。
    for (let page = 0; page < 50; page++) {
      const res = asObject(
        await callNcm(this.api.user_playlist!, {
          uid: userId,
          cookie,
          limit: pageSize,
          offset: page * pageSize,
        }),
      )
      const body = asObject(res.body)
      const list = asArray(body.playlist)
      raw.push(...list.map((p) => asObject(p)))
      if (body.more === false || list.length < pageSize) break
    }
    return raw
      .map((p) => asObject(p))
      // 过滤收藏类特殊歌单：specialType=5 是「我喜欢的音乐」收藏夹
      .filter((item) => Number(item.specialType ?? 0) === 0)
      .map((item) => {
        const id = String(item.id)
        return {
          id,
          name: pickString(item.name) ?? '未命名歌单',
          songCount: Number(item.trackCount ?? item.track_count ?? 0),
          coverUrl: pickString(item.coverImgUrl),
          webUrl: `https://music.163.com/#/playlist?id=${id}`,
          appUrl: `orpheus://playlist/${id}`,
        }
      })
  }

  protected async fetchPlaylistSongs(cookie: string, playlistId: string): Promise<PlatformSong[]> {
    const res = asObject(await callNcm(this.api.playlist_detail!, { id: playlistId, cookie }))
    const tracks = asObject(asObject(res.body).playlist).tracks
    return asArray(tracks).map(mapTrack)
  }

  protected async doSearch(
    cookie: string,
    keyword: string,
    limit: number,
    page = 1,
  ): Promise<PlatformSong[]> {
    // 新版搜索接口（/api/cloudsearch/pc）：旧 search 接口（/api/search/get）易被风控
    let res: JsonObject
    try {
      res = asObject(
        await this.api.cloudsearch!({
          keywords: keyword,
          type: 1,
          limit,
          offset: (page - 1) * limit,
          cookie,
        }),
      )
    } catch (e) {
      // NCM 风格错误：{ status, body: { code, message } }
      const obj = asObject(e)
      const body = asObject(obj.body)
      const message = pickString(body.message, body.msg) ?? '搜索请求失败'
      const code = body.code !== undefined ? Number(body.code) : undefined
      // 405 操作频繁、5xx 网络错误可重试
      const retryable = code === 405 || code === undefined || code >= 500
      this.log.warn('search.songs', '搜索请求失败', { keyword, code, retryable, message })
      throw new SearchError(message, retryable, code === 405)
    }
    const songs = asObject(asObject(res.body).result).songs
    return asArray(songs).map(mapTrack)
  }

  // --- 写原语 ---

  protected async doCreatePlaylist(cookie: string, name: string): Promise<string> {
    const res = asObject(await callNcm(this.api.playlist_create!, { name, privacy: '0', cookie }))
    const playlist = asObject(asObject(res.body).playlist)
    return pickString(playlist.id, asObject(res.body).id) ?? ''
  }

  protected async doAddSongs(cookie: string, playlistId: string, songIds: string[]): Promise<void> {
    await this.updateTracks(cookie, playlistId, 'add', songIds, '添加歌曲')
  }

  protected async doRenamePlaylist(cookie: string, playlistId: string, name: string): Promise<void> {
    const res = asObject(await callNcm(this.api.playlist_name_update!, { id: playlistId, name, cookie }))
    assertOk(asObject(res.body), '重命名歌单')
  }

  protected async doDeletePlaylist(cookie: string, playlistId: string): Promise<void> {
    const res = asObject(await callNcm(this.api.playlist_delete!, { id: playlistId, cookie }))
    assertOk(asObject(res.body), '删除歌单')
  }

  protected async doRemoveSongs(cookie: string, playlistId: string, songIds: string[]): Promise<void> {
    await this.updateTracks(cookie, playlistId, 'del', songIds, '移除歌曲')
  }

  /** 批量增删歌曲共用接口（新版批量操作，老接口易被风控） */
  private async updateTracks(
    cookie: string,
    playlistId: string,
    op: 'add' | 'del',
    songIds: string[],
    label: string,
  ): Promise<void> {
    const res = asObject(
      await callNcm(this.api.playlist_tracks!, {
        op,
        pid: playlistId,
        tracks: songIds.join(','),
        cookie,
      }),
    )
    assertOk(asObject(res.body), label, pickString(asObject(res.body).message, asObject(res.body).msg) ?? '')
  }
}

/** 写操作响应校验：code 非 200 抛出带原因的平台错误 */
function assertOk(body: JsonObject, action: string, message?: string): void {
  if (body.code !== undefined && Number(body.code) !== 200) {
    const suffix = message !== undefined ? `：${message}` : ''
    throw new Error(`网易云：${action}失败 code=${String(body.code)}${suffix}`)
  }
}

function mapTrack(t: unknown): PlatformSong {
  const item = asObject(t)
  const album = asObject(item.al ?? item.album)
  return {
    id: String(item.id),
    title: pickString(item.name, item.title) ?? '未知歌曲',
    artist: artistNames(asArray(item.ar ?? item.artists)),
    album: pickString(album.name),
    coverUrl: pickString(album.picUrl),
    durationMs: typeof item.dt === 'number' ? item.dt : undefined,
    genre: pickString(item.genre),
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
