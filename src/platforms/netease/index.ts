import { createRequire } from 'node:module'
import type {
  PlatformPlaylist,
  PlatformSong,
  PlatformSongIdentifiers,
} from '@core/models/platform'
import type {
  EncyclopediaCandidate,
  EncyclopediaContent,
  EncyclopediaKind,
  EncyclopediaTrack,
} from '@core/models/encyclopedia'
import type { SongDetailData } from '@core/models/songDetail'
import { SearchError } from '@core/models/sync'
import type { PlatformModule } from '../meta'
import {
  BasePlatformAdapter,
  type KeepAliveResult,
  type LoginStatusRaw,
  type PlatformEncyclopedia,
  type PlatformSongDetail,
  type QrCheckRaw,
} from '../base'
import {
  artistNames,
  asArray,
  asObject,
  compactIdentifiers,
  pickString,
  toHttps,
  type JsonObject,
} from '../json'
import { normalizeReleaseDate } from '../releaseDate'
import { attachSongUrl, songWebUrl } from '../songUrl'
import { logHttpError } from '@core/logging'

/** NeteaseCloudMusicApi 的模块函数签名（CJS） */
export type NcmApiFn = (query?: Record<string, unknown>) => Promise<unknown>

export type NcmApi = Record<string, NcmApiFn>

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

  /**
   * NCM 接口调用：将 NCM 风格对象异常（{ body: { code, message } }）
   * 转为带真实原因的 Error，避免错误原因被吞成 [object Object]；
   * 失败时记录完整出入参（开发模式，敏感字段脱敏）。
   */
  private async callNcm(fn: NcmApiFn, query?: Record<string, unknown>): Promise<unknown> {
    try {
      return await fn(query)
    } catch (e) {
      const name = this.apiNameOf(fn)
      if (e instanceof Error) {
        logHttpError(this.log, 'http.call', '网易云接口请求失败', e, {
          method: 'ncm',
          url: name,
          requestBody: query,
        })
        throw e
      }
      const body = asObject(asObject(e).body)
      const code = body.code !== undefined ? Number(body.code) : undefined
      const message = pickString(body.message, body.msg) ?? '网易云接口请求失败'
      const error = new Error(code !== undefined ? `网易云接口错误 code=${code}：${message}` : message)
      logHttpError(this.log, 'http.call', '网易云接口请求失败', error, {
        method: 'ncm',
        url: name,
        requestBody: query,
        responseBody: e,
      })
      throw error
    }
  }

  /** 反查库函数对应的接口名（仅失败分支调用，用于定位出错接口） */
  private apiNameOf(fn: NcmApiFn): string {
    for (const [name, candidate] of Object.entries(this.api)) {
      if (candidate === fn) return name
    }
    return fn.name || 'unknown'
  }

  // ==============================
  // 百科原语（歌手/专辑：公开内容，匿名可读）
  // ==============================

  readonly encyclopedia: PlatformEncyclopedia = {
    search: async (kind: EncyclopediaKind, name: string): Promise<EncyclopediaCandidate[]> => {
      return this.searchEncyclopedia(kind, name)
    },
    detail: async (
      kind: EncyclopediaKind,
      id: string,
      name?: string,
    ): Promise<EncyclopediaContent> => {
      return this.fetchEncyclopediaDetail(kind, id, name)
    },
  }

  private async searchEncyclopedia(kind: EncyclopediaKind, name: string): Promise<EncyclopediaCandidate[]> {
    const res = asObject(
      await this.callNcm(this.api.cloudsearch!, {
        keywords: name,
        type: kind === 'singer' ? 100 : 10,
        limit: 20,
        offset: 0,
      }),
    )
    const result = asObject(asObject(res.body).result)
    const rawList = asArray(kind === 'singer' ? result.artists : result.albums)
    return rawList
      .map((raw) => {
        const item = asObject(raw)
        const artist = asObject(item.artist)
        const aliases = asArray(item.alias ?? item.alia)
          .map((a) => pickString(a))
          .filter((a): a is string => a !== undefined && a.length > 0)
        return {
          id: String(item.id),
          name: pickString(item.name) ?? '',
          ...(aliases.length ? { aliases } : {}),
          picUrl: toHttps(pickString(item.picUrl, item.coverImgUrl, item.img1v1Url)),
          // 专辑候选附歌手名，帮助同名专辑消歧
          ...(kind === 'album' && pickString(artist.name)
            ? { singer: pickString(artist.name) }
            : {}),
        }
      })
      // 无 id 的残缺条目无法点选确认，直接过滤
      .filter((c) => c.id !== '')
  }

  private async fetchEncyclopediaDetail(
    kind: EncyclopediaKind,
    id: string,
    _name?: string,
  ): Promise<EncyclopediaContent> {
    if (kind === 'singer') return this.fetchSingerSongs(id)
    return this.fetchAlbumTracks(id)
  }

  /** 面板曲目附歌曲页跳转：网易歌曲页用数字 id（mapTrack 的 id 即数字 id） */
  private withSongUrl(song: PlatformSong): EncyclopediaTrack {
    return attachSongUrl(song, (s) => songWebUrl.netease(s.id))
  }

  /** 歌手的歌：artists 模块返回 artist + hotSongs（实测 50 首热门，条目同 track 形） */
  private async fetchSingerSongs(id: string): Promise<EncyclopediaContent> {
    const res = asObject(await this.callNcm(this.api.artists!, { id }))
    const body = asObject(res.body)
    const artist = asObject(body.artist)
    const songs = asArray(body.hotSongs).map((t) => this.withSongUrl(mapTrack(t)))
    return {
      kind: 'singer',
      id,
      name: pickString(artist.name) ?? '',
      songs,
      imageUrl: toHttps(pickString(artist.cover, artist.picUrl, artist.img1v1Url)),
      source: 'netease',
      sourceUrl: `https://music.163.com/#/artist?id=${encodeURIComponent(id)}`,
    }
  }

  /** 专辑曲目：album 模块返回专辑信息 + songs 曲目清单 + publishTime（实测） */
  private async fetchAlbumTracks(id: string): Promise<EncyclopediaContent> {
    const res = asObject(await this.callNcm(this.api.album!, { id }))
    const body = asObject(res.body)
    const album = asObject(body.album)
    const songs = asArray(body.songs).map((t) => this.withSongUrl(mapTrack(t)))
    return {
      kind: 'album',
      id,
      name: pickString(album.name) ?? '',
      releaseDate: normalizeReleaseDate(pickString(album.publishTime)),
      songs,
      imageUrl: toHttps(pickString(album.picUrl, album.blurPicUrl)),
      source: 'netease',
      sourceUrl: `https://music.163.com/#/album?id=${encodeURIComponent(id)}`,
    }
  }

  // ==============================
  // 歌曲详情补充（歌词 + 发行时间；歌词接口匿名可用）
  // ==============================

  readonly songDetail: PlatformSongDetail = {
    detail: (songId, identifiers, meta): Promise<SongDetailData> => {
      return this.fetchSongDetail(songId, identifiers, meta)
    },
  }

  private async fetchSongDetail(
    songId: string,
    identifiers: PlatformSongIdentifiers,
    _meta?: { title?: string; artist?: string },
  ): Promise<SongDetailData> {
    const id = Number(songId)
    const [lyricRes, detailRes] = await Promise.all([
      this.callNcm(this.api.lyric!, { id }).catch(() => null),
      this.callNcm(this.api.song_detail!, { ids: String(id) }).catch(() => null),
    ])
    const song = asObject(asArray(asObject(asObject(detailRes).body).songs)[0])
    // 发行时间优先歌曲自身 publishTime（毫秒时间戳），缺失时回退专辑详情
    let releaseDate = normalizeReleaseDate(pickString(song.publishTime))
    if (!releaseDate) {
      const albumId = pickString(asObject(song.al).id, identifiers.albumId)
      if (albumId) {
        const albumRes = asObject(
          await this.callNcm(this.api.album!, { id: Number(albumId) }).catch(() => null),
        )
        releaseDate = normalizeReleaseDate(pickString(asObject(asObject(albumRes.body).album).publishTime))
      }
    }
    // 实测：lyric 模块返回 { status, body, cookie }，歌词在 body.lrc.lyric
    const lyrics = lyricRes
      ? pickString(asObject(asObject(asObject(lyricRes).body).lrc).lyric)
      : undefined
    return {
      lyrics,
      releaseDate,
      webUrl: songWebUrl.netease(songId),
    }
  }

  // --- 读原语 ---

  protected async qrCreateKey(_channel?: string): Promise<string> {
    const keyRes = asObject(await this.callNcm(this.api.login_qr_key!))
    const key = pickString(asObject(asObject(keyRes.body).data).unikey)
    if (!key) throw new Error('网易云：获取二维码 key 失败')
    return key
  }

  protected async qrBuildImage(key: string): Promise<string | undefined> {
    const qrRes = asObject(await this.callNcm(this.api.login_qr_create!, { key, qrimg: true }))
    return pickString(asObject(asObject(qrRes.body).data).qrimg)
  }

  protected async qrCheckStatus(key: string): Promise<QrCheckRaw> {
    const res = asObject(await this.callNcm(this.api.login_qr_check!, { key }))
    const body = asObject(res.body)
    return {
      code: body.code as number | undefined,
      cookie: pickString(body.cookie),
    }
  }

  protected async fetchLoginStatus(cookie: string): Promise<LoginStatusRaw> {
    const res = asObject(await this.callNcm(this.api.login_status!, { cookie }))
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
      const res = asObject(await this.callNcm(this.api.login_refresh!, { cookie }))
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
        await this.callNcm(this.api.user_playlist!, {
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
      // 过滤收藏类特殊歌单：specialType=5 是「我喜欢的音乐」收藏夹；
      // subscribed=true 为收藏的他人歌单，与自建/系统歌单规则一致（仅显示自有歌单）
      .filter(
        (item) => Number(item.specialType ?? 0) === 0 && item.subscribed !== true,
      )
      .map((item) => {
        const id = String(item.id)
        return {
          id,
          name: pickString(item.name) ?? '未命名歌单',
          songCount: Number(item.trackCount ?? item.track_count ?? 0),
          coverUrl: toHttps(pickString(item.coverImgUrl)),
          webUrl: `https://music.163.com/#/playlist?id=${id}`,
          appUrl: `orpheus://playlist/${id}`,
          ownerId: pickString(asObject(item.creator).userId, item.userId),
        }
      })
  }

  protected async fetchPlaylistSongs(cookie: string, playlistId: string): Promise<PlatformSong[]> {
    const res = asObject(await this.callNcm(this.api.playlist_detail!, { id: playlistId, cookie }))
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
    const res = asObject(await this.callNcm(this.api.playlist_create!, { name, privacy: '0', cookie }))
    const playlist = asObject(asObject(res.body).playlist)
    return pickString(playlist.id, asObject(res.body).id) ?? ''
  }

  protected async doAddSongs(cookie: string, playlistId: string, songIds: string[]): Promise<void> {
    await this.updateTracks(cookie, playlistId, 'add', songIds, '添加歌曲')
  }

  protected async doRenamePlaylist(cookie: string, playlistId: string, name: string): Promise<void> {
    const res = asObject(await this.callNcm(this.api.playlist_name_update!, { id: playlistId, name, cookie }))
    assertOk(asObject(res.body), '重命名歌单')
  }

  protected async doDeletePlaylist(cookie: string, playlistId: string): Promise<void> {
    const res = asObject(await this.callNcm(this.api.playlist_delete!, { id: playlistId, cookie }))
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
      await this.callNcm(this.api.playlist_tracks!, {
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
  const originSong = asObject(item.originSongSimpleData)
  const aliases = asArray(item.alia)
    .map((a) => pickString(a))
    .filter((a): a is string => a !== undefined)
  const singerIds = asArray(item.ar ?? item.artists)
    .map((a) => pickString(asObject(a).id))
    // 上游翻唱/改编条目的歌手 id 常为 0（数字 0 经 pickString 转成 "0"），
    // 直达 artists 接口必 404：过滤掉，点击时回退名字搜索
    .filter((id): id is string => id !== undefined && id !== '0')
  const identifiers = {
    albumId: pickString(album.id),
    ...(singerIds.length ? { singerIds } : {}),
    originSongId: pickString(originSong.songId),
    aliases,
  }
  return {
    id: String(item.id),
    title: pickString(item.name, item.title) ?? '未知歌曲',
    artist: artistNames(asArray(item.ar ?? item.artists)),
    album: pickString(album.name),
    coverUrl: toHttps(pickString(album.picUrl)),
    durationMs: typeof item.dt === 'number' ? item.dt : undefined,
    genre: pickString(item.genre),
    identifiers: compactIdentifiers(identifiers),
  }
}

/** 网易云音乐平台插件模块 */
const neteaseModule: PlatformModule = {
  meta: {
    id: 'netease',
    name: '网易云音乐',
    icon: 'graphic_eq',
    capabilities: { read: true, write: true, encyclopedia: true },
  },
  createAdapter: () => {
    // 重依赖懒加载：测试环境 import 本模块不会触发 require
    const ncm = createRequire(import.meta.url)('NeteaseCloudMusicApi') as NcmApi
    return new NeteaseAdapter(ncm)
  },
}

export default neteaseModule
