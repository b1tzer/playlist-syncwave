import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import type { PlatformModule } from '../meta'
import {
  BasePlatformAdapter,
  type KeepAliveResult,
  type LoginStatusRaw,
  type QrCheckRaw,
} from '../base'
import { asArray, asObject, pickString, type JsonObject } from '../json'

/** 酷狗 API 库模式的扁平函数签名（kugoumusicapi main.js 导出） */
export type KugouApiFn = (params?: Record<string, unknown>) => Promise<KugouResponse>

export type KugouApi = Record<string, KugouApiFn>

/** 库函数统一返回结构 */
export interface KugouResponse {
  status: number
  body: unknown
  cookie: string[]
  headers?: Record<string, string>
}

/** 酷狗设备指纹：token 与设备绑定，扫码/取数/写歌单前必须常驻同一组指纹 */
export interface KugouDevice {
  /** md5(uuid) 的 32 位 hex（等价官方服务的 KUGOU_API_GUID） */
  guid: string
  /** 由 guid 派生的 30+ 位十进制设备 MID */
  mid: string
  /** 10 位大写设备标识（KUGOU_API_DEV） */
  dev: string
  /** register_dev 注册返回的真实设备指纹 */
  dfid?: string
}

/** 加歌/删歌需要的歌曲元数据缓存（搜索与歌单歌曲拉取时顺带填充） */
interface SongAddMeta {
  name: string
  albumId?: number
  mixSongId?: number
  /** 云歌单内条目 id：删除歌曲接口按 fileid 而非 hash */
  fileId?: string
}

/** 歌单索引缓存：写操作与歌曲拉取需要区分自建/收藏歌单与版本号 */
interface PlaylistIndexEntry {
  listId: string
  /** 0=自建/我喜欢，1=收藏 */
  type: number
  /** 歌单版本号：重命名等修改接口必须携带 */
  totalVer: number
  /** 公开歌单 id（回退拉取收藏歌单歌曲用） */
  globalCollectionId?: string
}

/** 酷狗接口错误：携带 HTTP 状态与平台 error_code，供错误分类判定 */
class KugouApiError extends Error {
  constructor(
    public readonly status: number | undefined,
    public readonly errorCode: number | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'KugouApiError'
  }
}

/** 将库函数 reject 的响应对象（{ status, body, cookie, headers }）归一为错误 */
function toKugouError(e: unknown): KugouApiError {
  const obj = asObject(e)
  const body = asObject(obj.body)
  const status = typeof obj.status === 'number' ? obj.status : undefined
  const errorCode = typeof body.error_code === 'number' ? body.error_code : undefined
  const raw =
    pickString(body.error_msg, body.error, body.msg) ??
    (e instanceof Error ? e.message : '酷狗接口请求失败')
  const message = raw.startsWith('酷狗') ? raw : `酷狗：${raw}`
  return new KugouApiError(status, errorCode, message)
}

/** 会话明确失效的酷狗错误码：20017/20018 设备绑定问题，20028 触发安全验证 */
function isSessionDeadError(e: unknown): boolean {
  const err = e instanceof KugouApiError ? e : toKugouError(e)
  return err.errorCode === 20017 || err.errorCode === 20018 || err.errorCode === 20028
}

/** 凭证 cookie 字符串 → 键值对（值内可含 =，用首个 = 分割） */
function parseCredential(cookie: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    if (key) out[key] = part.slice(idx + 1).trim()
  }
  return out
}

function assembleCredential(pairs: Record<string, string | number | undefined>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(';')
}

function md5Hex(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

/** md5 hex → 十进制大数（等价官方 calculateMid，全程 BigInt 避免精度丢失） */
function calculateMid(hex: string): string {
  let n = 0n
  for (const ch of hex) n = (n << 4n) + BigInt(parseInt(ch, 16))
  return n.toString()
}

const DEV_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function randomDev(len: number): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += DEV_ALPHABET[bytes[i] % DEV_ALPHABET.length]
  return out
}

/** 加载或生成设备指纹，持久化到 userData，保证跨重启 token 仍与设备匹配 */
function loadKugouDevice(userDataDir: string): KugouDevice {
  const file = join(userDataDir, 'kugou-device.json')
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<KugouDevice>
      if (parsed.guid && parsed.mid && parsed.dev) {
        return { guid: parsed.guid, mid: parsed.mid, dev: parsed.dev, dfid: parsed.dfid }
      }
    }
  } catch {
    // 文件损坏则重新生成
  }
  const guid = md5Hex(randomUUID())
  const device: KugouDevice = { guid, mid: calculateMid(guid), dev: randomDev(10), dfid: undefined }
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(file, JSON.stringify(device, null, 2), 'utf-8')
  } catch {
    // userData 不可写时仅内存生效
  }
  return device
}

/** 去掉搜索结果标题里的高亮标签（如 <em>、<font>） */
function stripHighlightTags(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

/** 酷狗封面 URL 常带 {size} 占位符，替换为 480 尺寸 */
function normalizeCover(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.replace('{size}', '480')
}

/**
 * 酷狗适配器：基于 MakcRe/KuGouMusicApi（库模式，createRequire 直调，不启动 HTTP 服务）。
 * 仅实现平台差异原语（接口调用与字段映射），
 * 流程骨架（扫码状态机/耗时统计/统一日志）由 BasePlatformAdapter 模板方法提供。
 */
export class KugouAdapter extends BasePlatformAdapter {
  readonly platform = 'kugou'
  protected readonly platformLabel = '酷狗音乐'

  /** hash → 加歌/删歌元数据缓存（搜索、歌单歌曲拉取时填充） */
  private readonly songMeta = new Map<string, SongAddMeta>()
  /** listid → 歌单索引缓存（拉取歌单列表时填充） */
  private readonly playlistIndex = new Map<string, PlaylistIndexEntry>()

  constructor(
    private readonly api: KugouApi,
    private readonly device: KugouDevice,
    private readonly userDataDir?: string,
  ) {
    super()
  }

  /** 库函数统一调用：成功返回 body，reject 的响应对象归一为 KugouApiError */
  private async call(fn: KugouApiFn, params?: Record<string, unknown>): Promise<JsonObject> {
    try {
      const res = await fn(params)
      return asObject(res.body)
    } catch (e) {
      throw toKugouError(e)
    }
  }

  /** 凭证 + 设备指纹合并为库函数 cookie 参数（设备标识注入每个请求） */
  private buildCookie(credential: string): Record<string, string> {
    const cookie: Record<string, string> = {
      ...parseCredential(credential),
      KUGOU_API_GUID: this.device.guid,
      KUGOU_API_MID: this.device.mid,
      KUGOU_API_DEV: this.device.dev,
      KUGOU_API_MAC: '02:00:00:00:00:00',
    }
    if (this.device.dfid) cookie.dfid = this.device.dfid
    return cookie
  }

  private persistDevice(): void {
    if (!this.userDataDir) return
    try {
      mkdirSync(this.userDataDir, { recursive: true })
      writeFileSync(
        join(this.userDataDir, 'kugou-device.json'),
        JSON.stringify(this.device, null, 2),
        'utf-8',
      )
    } catch (e) {
      this.log.warn('device.persist', '设备指纹持久化失败', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  /** 扫码前必须持有真实 dfid（未注册的 token 会被设备绑定风控拦截） */
  private async ensureDfid(): Promise<void> {
    if (this.device.dfid) return
    try {
      const res = await this.call(this.api.register_dev!, { cookie: this.buildCookie('') })
      const data = asObject(res.data ?? res)
      const dfid = pickString(data.dfid)
      if (dfid) {
        this.device.dfid = dfid
        this.persistDevice()
        this.log.info('device.register', '设备注册成功，已获取 dfid')
      }
    } catch (e) {
      this.log.warn('device.register', '设备注册失败，继续用占位 dfid 出码', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // --- 读原语 ---

  protected async qrCreateKey(_channel?: string): Promise<string> {
    await this.ensureDfid()
    const res = await this.call(this.api.login_qr_key!, { cookie: this.buildCookie('') })
    const data = asObject(res.data ?? res)
    const key = pickString(data.qrcode, data.key)
    if (!key) throw new Error('酷狗：获取二维码 key 失败')
    return key
  }

  protected async qrBuildImage(key: string): Promise<string | undefined> {
    // 官方库本地生成二维码（qrimg=true 返回 base64 dataURL）
    const res = await this.call(this.api.login_qr_create!, { key, qrimg: true })
    const data = asObject(res.data ?? res)
    return pickString(data.base64, data.qrimg)
  }

  protected async qrCheckStatus(key: string): Promise<QrCheckRaw> {
    const res = await this.call(this.api.login_qr_check!, {
      key,
      cookie: this.buildCookie(''),
    })
    const data = asObject(res.data ?? res)
    // 酷狗状态码：0 过期 / 1 等待 / 2 已扫待确认 / 4 成功（映射为基类统一状态机）
    const status = typeof data.status === 'number' ? data.status : undefined
    let code: number | undefined
    if (status === 0) code = 800
    else if (status === 2) code = 802
    else if (status === 4) code = 803
    const token = pickString(data.token)
    const userid = pickString(data.userid)
    return {
      code,
      cookie: code === 803 && token && userid ? assembleCredential({ token, userid }) : undefined,
    }
  }

  protected async fetchLoginStatus(credential: string): Promise<LoginStatusRaw> {
    let lastErr: unknown
    // 主路径：get_my_userinfo（社区实测可用，响应为明文平铺 data.userid/nickname）
    try {
      const res = await this.call(this.api.user_info!, { cookie: this.buildCookie(credential) })
      const data = asObject(res.data ?? res)
      const info = asObject(data.info)
      const userId = pickString(data.userid, info.userid, info.uid)
      if (userId) {
        return { userId, nickname: pickString(data.nickname, info.nickname, info.nick) }
      }
    } catch (e) {
      lastErr = e
    }
    // 回退：get_my_info（响应结构部分协议版本为 data.info 嵌套）
    try {
      const res = await this.call(this.api.user_detail!, { cookie: this.buildCookie(credential) })
      const data = asObject(res.data ?? res)
      const info = asObject(data.info)
      const userId = pickString(info.userid, info.uid, data.userid)
      if (userId) {
        return { userId, nickname: pickString(info.nickname, info.nick, data.nickname) }
      }
      // 接口可用但账号信息缺失：视为未登录
      return { userId: undefined }
    } catch (e) {
      lastErr = e
    }
    // 会话明确失效不兜底（避免保活误判 alive）
    if (isSessionDeadError(lastErr)) throw toKugouError(lastErr)
    // 兜底：扫码刚签发的凭证自带 userid，接口暂时不可用时仍视为已登录
    const parsed = parseCredential(credential)
    if (parsed.userid) return { userId: parsed.userid, nickname: '酷狗用户' }
    throw lastErr instanceof Error ? lastErr : new Error('酷狗：查询登录状态失败')
  }

  protected async doKeepAlive(credential: string): Promise<KeepAliveResult> {
    // 优先 login_by_token 续期；失败（如风控）回退为登录态校验
    try {
      const res = await this.call(this.api.login_token!, { cookie: this.buildCookie(credential) })
      const data = asObject(res.data ?? res)
      const token = pickString(data.token)
      if (token) {
        const parsed = parseCredential(credential)
        return {
          alive: true,
          cookie: assembleCredential({
            token,
            userid: pickString(data.userid) ?? parsed.userid ?? '',
            t1: pickString(data.t1),
            vip_type: pickString(data.vip_type),
            vip_token: pickString(data.vip_token),
          }),
        }
      }
      return { alive: true }
    } catch (e) {
      // 会话明确失效（设备不匹配/需验证）直接判死，其余保持现状
      if (isSessionDeadError(e)) return { alive: false }
      this.log.debug('keepalive.check', 'token 刷新失败，回退为登录态校验', {
        message: e instanceof Error ? e.message : String(e),
      })
    }
    try {
      const raw = await this.fetchLoginStatus(credential)
      return { alive: Boolean(raw.userId) }
    } catch (e) {
      if (isSessionDeadError(e)) return { alive: false }
      // 网络类异常交由模板方法保持现状，避免误判失效
      throw e
    }
  }

  protected async fetchPlaylists(credential: string, _userId: string): Promise<PlatformPlaylist[]> {
    const items = await this.fetchPlaylistItems(credential)
    return items.map((item) => this.mapPlaylist(item))
  }

  /** 分页拉取用户歌单原始条目并重建 listid 索引缓存 */
  private async fetchPlaylistItems(credential: string): Promise<JsonObject[]> {
    const raw: JsonObject[] = []
    const pageSize = 100
    for (let page = 1; page <= 50; page++) {
      const res = await this.call(this.api.user_playlist!, {
        page,
        pagesize: pageSize,
        cookie: this.buildCookie(credential),
      })
      const data = asObject(res.data ?? res)
      const info = asArray(data.info).map((p) => asObject(p))
      // 收藏的他人歌单在部分协议版本单独返回
      const other = asArray(data.other_special ?? data.otherSpecial).map((p) => asObject(p))
      raw.push(...info, ...other)
      const total = typeof data.total === 'number' ? data.total : undefined
      if (info.length < pageSize || (total !== undefined && raw.length >= total)) break
    }
    for (const item of raw) {
      const listId = pickString(item.listid, item.list_id)
      if (!listId) continue
      this.playlistIndex.set(listId, {
        listId,
        type: Number(item.list_type ?? 0),
        totalVer: Number(item.total_ver ?? 0),
        globalCollectionId: pickString(item.global_collection_id),
      })
    }
    return raw
  }

  private mapPlaylist(item: JsonObject): PlatformPlaylist {
    const id = pickString(item.listid, item.list_id) ?? ''
    return {
      id,
      name: pickString(item.name, item.title) ?? '未命名歌单',
      songCount: Number(item.song_count ?? item.count ?? 0),
      coverUrl: pickString(item.pic, item.pic_url, item.img_url),
    }
  }

  /** 查询歌单索引：缓存 miss 时重拉歌单列表刷新（写操作依赖 type/total_ver） */
  private async resolvePlaylistMeta(
    credential: string,
    playlistId: string,
  ): Promise<PlaylistIndexEntry> {
    const cached = this.playlistIndex.get(playlistId)
    if (cached) return cached
    await this.fetchPlaylistItems(credential)
    const fresh = this.playlistIndex.get(playlistId)
    if (!fresh) throw new Error(`酷狗：找不到歌单 ${playlistId}，请先刷新歌单列表`)
    return fresh
  }

  protected async fetchPlaylistSongs(
    credential: string,
    playlistId: string,
  ): Promise<PlatformSong[]> {
    const meta = await this.resolvePlaylistMeta(credential, playlistId)
    let items = await this.fetchTrackAllNew(credential, playlistId, meta.type)
    if (items.length === 0 && meta.globalCollectionId) {
      // 云歌单接口覆盖不到时回退公开歌单接口
      items = await this.fetchTrackAll(credential, meta.globalCollectionId)
    }
    return items.map((item) => this.mapPlaylistSong(item))
  }

  /** 云歌单歌曲接口（App 现行端点，覆盖自建与收藏歌单） */
  private async fetchTrackAllNew(
    credential: string,
    playlistId: string,
    type: number,
  ): Promise<JsonObject[]> {
    const raw: JsonObject[] = []
    const pageSize = 300
    for (let page = 1; page <= 50; page++) {
      const res = await this.call(this.api.playlist_track_all_new!, {
        listid: playlistId,
        type,
        page,
        pagesize: pageSize,
        cookie: this.buildCookie(credential),
      })
      const data = asObject(res.data ?? res)
      const info = asArray(data.info).map((s) => asObject(s))
      raw.push(...info)
      const total = typeof data.total === 'number' ? data.total : undefined
      if (info.length < pageSize || (total !== undefined && raw.length >= total)) break
    }
    return raw
  }

  /** 公开歌单歌曲接口（按 global_collection_id） */
  private async fetchTrackAll(
    credential: string,
    globalCollectionId: string,
  ): Promise<JsonObject[]> {
    const raw: JsonObject[] = []
    const pageSize = 300
    for (let page = 1; page <= 50; page++) {
      const res = await this.call(this.api.playlist_track_all!, {
        id: globalCollectionId,
        page,
        pagesize: pageSize,
        cookie: this.buildCookie(credential),
      })
      const data = asObject(res.data ?? res)
      const info = asArray(data.info).map((s) => asObject(s))
      raw.push(...info)
      if (info.length < pageSize) break
    }
    return raw
  }

  /** 歌单内歌曲条目 → 领域模型，同时缓存加歌/删歌元数据 */
  private mapPlaylistSong(item: JsonObject): PlatformSong {
    const hash = (pickString(item.hash, item.file_hash, item.song_hash) ?? '').toLowerCase()
    const filename = pickString(item.filename) ?? ''
    // filename 兜底为「歌名 - 歌手」，用最后一个 - 分割，兼容歌名本身含 -
    const dash = filename.lastIndexOf('-')
    const title =
      pickString(item.name, item.songname, item.title) ??
      (dash > 0 ? filename.slice(0, dash).trim() : filename)
    const artist =
      pickString(item.singer, item.singername, item.author) ??
      (dash > 0 ? filename.slice(dash + 1).trim() : '')
    if (hash) {
      this.songMeta.set(hash, {
        name: title || '未知歌曲',
        albumId: typeof item.album_id === 'number' ? item.album_id : Number(item.album_id ?? 0),
        mixSongId: typeof item.mixsongid === 'number' ? item.mixsongid : Number(item.mixsongid ?? 0),
        fileId: pickString(item.fileid, item.file_id, item.id),
      })
    }
    return {
      id: hash,
      title: title || '未知歌曲',
      artist,
      album: pickString(item.album_name, item.albumname),
      coverUrl: normalizeCover(pickString(item.img, item.pic, item.image)),
      durationMs: typeof item.duration === 'number' ? item.duration * 1000 : undefined,
    }
  }

  // --- 搜索 ---

  protected async doSearch(credential: string, keyword: string, limit: number): Promise<PlatformSong[]> {
    try {
      const res = await this.call(this.api.search!, {
        keyword,
        page: 1,
        pagesize: limit,
        cookie: this.buildCookie(credential),
      })
      const data = asObject(res.data ?? res)
      const lists = asArray(data.lists)
      const list = lists.length > 0 ? asArray(lists[0]) : []
      return list.map((s) => this.mapSearchItem(asObject(s)))
    } catch (e) {
      // 平台错误分类：网络/服务错误可重试，error_code=1002 为高频风控限流
      const err = e instanceof KugouApiError ? e : toKugouError(e)
      const retryable = err.status === undefined || err.status === 502 || err.status >= 500
      const rateLimited = err.errorCode === 1002
      this.log.warn('search.songs', '搜索请求失败', {
        keyword,
        status: err.status,
        errorCode: err.errorCode,
        retryable,
        message: err.message,
      })
      throw new SearchError(err.message, retryable, rateLimited)
    }
  }

  private mapSearchItem(item: JsonObject): PlatformSong {
    const hash = (pickString(item.FileHash, item.filehash, item.hash) ?? '').toLowerCase()
    const title = stripHighlightTags(pickString(item.SongName, item.songname, item.name) ?? '未知歌曲')
    if (hash) {
      this.songMeta.set(hash, {
        name: title,
        albumId: typeof item.AlbumID === 'number' ? item.AlbumID : Number(item.AlbumID ?? 0),
        mixSongId:
          typeof item.MixSongID === 'number' ? item.MixSongID : Number(item.MixSongID ?? 0),
      })
    }
    return {
      id: hash,
      title,
      artist: pickString(item.SingerName, item.singername, item.singer) ?? '',
      album: pickString(item.AlbumName, item.albumname),
      coverUrl: normalizeCover(pickString(item.Image, item.img, item.pic)),
      durationMs: typeof item.Duration === 'number' ? item.Duration * 1000 : undefined,
    }
  }

  // --- 写原语 ---

  protected async doCreatePlaylist(credential: string, name: string): Promise<string> {
    const trimmed = name.trim()
    const res = await this.call(this.api.playlist_add!, {
      name: trimmed,
      type: 0,
      cookie: this.buildCookie(credential),
    })
    const data = asObject(res.data ?? res)
    const id = pickString(data.listid, data.list_id, res.listid)
    if (!id) throw new Error('酷狗：创建歌单失败')
    this.playlistIndex.set(id, { listId: id, type: 0, totalVer: 0 })
    return id
  }

  protected async doAddSongs(
    credential: string,
    playlistId: string,
    songIds: string[],
  ): Promise<void> {
    for (let i = 0; i < songIds.length; i += 100) {
      const batch = songIds.slice(i, i + 100)
      // 加歌接口要求 名称|hash|album_id|mixsongid，元数据在搜索/拉歌单时已缓存
      const data = batch
        .map((id) => {
          const meta = this.songMeta.get(id.toLowerCase())
          if (!meta) {
            throw new Error(`酷狗：歌曲 ${id} 缺少元数据，请重新匹配后再试`)
          }
          const name = meta.name.replace(/[|,]/g, ' ')
          return `${name}|${id.toLowerCase()}|${meta.albumId ?? 0}|${meta.mixSongId ?? 0}`
        })
        .join(',')
      await this.call(this.api.playlist_tracks_add!, {
        listid: playlistId,
        data,
        cookie: this.buildCookie(credential),
      })
      this.log.debug('playlist.add-songs', '写入一批歌曲', { playlistId, batch: batch.length })
    }
  }

  protected async doRemoveSongs(
    credential: string,
    playlistId: string,
    songIds: string[],
  ): Promise<void> {
    // 删除接口按云歌单条目 fileid 而非 hash：缓存缺失时先拉歌单歌曲填充
    if (songIds.some((id) => !this.songMeta.get(id.toLowerCase())?.fileId)) {
      await this.fetchPlaylistSongs(credential, playlistId)
    }
    const fileids = songIds.map((id) => this.songMeta.get(id.toLowerCase())?.fileId)
    if (fileids.some((f) => !f)) {
      throw new Error('酷狗：部分歌曲未在歌单内找到，移除失败')
    }
    await this.call(this.api.playlist_tracks_del!, {
      listid: playlistId,
      fileids: fileids.join(','),
      cookie: this.buildCookie(credential),
    })
  }

  protected async doRenamePlaylist(
    credential: string,
    playlistId: string,
    name: string,
  ): Promise<void> {
    const meta = await this.resolvePlaylistMeta(credential, playlistId)
    await this.call(this.api.playlist_update!, {
      listid: playlistId,
      name,
      type: meta.type,
      total_ver: meta.totalVer,
      cookie: this.buildCookie(credential),
    })
  }

  protected async doDeletePlaylist(credential: string, playlistId: string): Promise<void> {
    await this.call(this.api.playlist_del!, {
      listid: playlistId,
      cookie: this.buildCookie(credential),
    })
  }
}

/** 酷狗音乐平台插件模块 */
const kugouModule: PlatformModule = {
  meta: {
    id: 'kugou',
    name: '酷狗音乐',
    apiLabel: 'KuGouMusic API: v1.6.3 (Direct)',
    icon: 'music_note',
    capabilities: { read: true, write: true },
  },
  createAdapter: (ctx) => {
    // 重依赖懒加载：测试环境 import 本模块不会触发 require
    const api = createRequire(import.meta.url)('kugoumusicapi') as KugouApi
    const device = loadKugouDevice(ctx.userDataDir)
    return new KugouAdapter(api, device, ctx.userDataDir)
  },
}

export default kugouModule
