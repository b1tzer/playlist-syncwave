import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'
import { SearchError } from '@core/models/sync'
import type {
  EncyclopediaCandidate,
  EncyclopediaContent,
  EncyclopediaKind,
  EncyclopediaTrack,
} from '@core/models/encyclopedia'
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
  type JsonObject,
} from '../json'
import { normalizeReleaseDate } from '../releaseDate'
import { attachSongUrl, songWebUrl } from '../songUrl'
import { logHttpError } from '@core/logging'

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

function toIdString(value: number | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : undefined
}

/** 歌手/实体 id 数组 → 字符串数组（数字/字符串/带 id 字段的对象均兼容），去重去空；数字 0 视为缺 id（同网易云上游脏数据） */
function toIdList(value: unknown): string[] | undefined {
  const ids = asArray(value)
    .map((x) => {
      if (typeof x === 'number') return x > 0 ? String(x) : undefined
      if (typeof x === 'string') return x
      const o = asObject(x)
      return pickString(o.id, o.singerid, o.singer_id, o.singerId)
    })
    .filter((x): x is string => Boolean(x) && x !== '0')
  const unique = [...new Set(ids)]
  return unique.length > 0 ? unique : undefined
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
export function loadKugouDevice(userDataDir: string): KugouDevice {
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

/** 酷狗封面 URL 常带 {size} 占位符，替换为指定尺寸并强制 https */
function normalizeCover(url: string | undefined, size = '240'): string | undefined {
  if (!url) return undefined
  return url.replace('{size}', size).replace(/^http:/, 'https:')
}

/** 官方歌曲图床：云歌单条目不带封面字段时按 hash 拼接（实测可用） */
function hashCover(hash: string): string | undefined {
  if (!hash) return undefined
  return `https://imge.kugou.com/stdmusic/240/${hash}.jpg`
}

/**
 * 构造官方分享页 songlist/{gcid} 链接（自建/收藏歌单通用，PC 浏览器可打开）。
 * 页面依赖四个查询参数缺一不可（实测）：src_cid 为 gcid 去 gcid_ 前缀、
 * uid 为歌单创建者、chl=link、iszlist=1。
 * 自建歌单创建者即登录用户（userId 兜底）；收藏歌单取条目里的创建者字段。
 * 任一项缺失时返回 undefined，由调用方回退旧链接。
 */
function buildSonglistShareUrl(
  gcid: string | undefined,
  item: JsonObject,
  userId: string,
): string | undefined {
  if (!gcid?.startsWith('gcid_')) return undefined
  const creatorUid = pickString(item.list_create_userid, item.create_userid) ?? userId
  if (!creatorUid) return undefined
  const srcCid = gcid.slice('gcid_'.length)
  const params = new URLSearchParams({
    src_cid: srcCid,
    uid: creatorUid,
    chl: 'link',
    iszlist: '1',
  })
  return `https://www.kugou.com/songlist/${gcid}/?${params.toString()}`
}

/**
 * 构造自建歌单的官方分享页链接（浏览器可打开）。
 * 参数取自 kugoumusicapi 的 playlist_share_official 客户端分享构造逻辑：
 * 自建歌单 specialid 用哨兵值 -2147483648、cType=0，真实标识为 global_specialid=歌单 listid；
 * h1/h2 为客户端硬编码常量，若官方客户端升级更换导致分享页失效，
 * 可改为调用 playlist_share_official 接口换取官方短链。
 */
function buildOwnPlaylistShareUrl(userId: string, listId: string): string {
  const params = new URLSearchParams({
    u: userId,
    h1: '143298444507010930495471534764048014549',
    h2: '406dd14b2efd5e51affd6da64c84d0f6',
    specialid: '-2147483648',
    global_specialid: listId,
    cType: '0',
  })
  return `https://activity.kugou.com/share/v-a00a45b0/index.html?${params.toString()}`
}

/**
 * 时长合理性防御：酷狗部分条目 timelen 为脏数据（如 45 小时），
 * 超过 24 小时视为无效置空，避免 UI 显示异常时长。
 */
function saneDuration(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 3600_000) return undefined
  return ms
}

/**
 * 云歌单 timelen 归一化：正常为毫秒；个别条目（如 162000000）实为
 * 微秒脏值，换算后落在 10 秒 ~ 2 小时区间视为有效（162000000µs = 2:42）。
 */
function normalizeKgTimelen(timelen: number): number | undefined {
  if (timelen > 0 && timelen <= 24 * 3600_000) return timelen
  const asSeconds = timelen / 1_000_000
  if (Number.isFinite(asSeconds) && asSeconds >= 10 && asSeconds <= 2 * 3600) {
    return Math.round(asSeconds * 1000)
  }
  return undefined
}

/** 「歌手 - 标题.mp3」→ { artist, title }：剥扩展名，按第一个 ' - ' 分割 */
function splitKgFilename(filename: string): { artist: string; title: string } {
  const bare = filename.replace(/\.(mp3|flac|m4a|ogg|ape|wav)$/i, '')
  const idx = bare.indexOf(' - ')
  if (idx > 0) {
    return { artist: bare.slice(0, idx).trim(), title: bare.slice(idx + 3).trim() }
  }
  return { artist: '', title: bare.trim() }
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
      const error = toKugouError(e)
      // 失败时记录完整出入参（开发模式；params 中的 cookie/token 经脱敏掩码）
      logHttpError(this.log, 'http.call', '酷狗接口请求失败', error, {
        method: 'kugou',
        url: this.apiNameOf(fn),
        requestBody: params,
        responseBody: e,
      })
      throw error
    }
  }

  /** 反查库函数对应的接口名（仅失败分支调用，用于定位出错接口） */
  private apiNameOf(fn: KugouApiFn): string {
    for (const [name, candidate] of Object.entries(this.api)) {
      if (candidate === fn) return name
    }
    return fn.name || 'unknown'
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

  protected async fetchPlaylists(credential: string, userId: string): Promise<PlatformPlaylist[]> {
    const items = await this.fetchPlaylistItems(credential)
    // 平台规则：收藏的他人歌单（type=1）不在歌单列表显示。
    // 实测 v7/get_all_list 条目：type 0=自建/系统收藏夹（默认收藏 is_def=1、我喜欢 is_def=2），
    // 1=收藏他人歌单（list_create_userid 为他人）；is_mine 恒为 0，不可用于判定。
    // 过滤只作用于显示列表；fetchPlaylistItems 建立的写操作索引（playlistIndex）保持完整。
    return items
      .filter((item) => Number(item.type ?? 0) !== 1)
      .map((item) => this.mapPlaylist(item, userId))
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
    if (raw.length > 0) {
      this.log.info('playlist.list', '歌单条目原始字段采样', { sample: raw[0] })
    }
    for (const item of raw) {
      const listId = pickString(item.listid, item.id)
      if (!listId) continue
      this.playlistIndex.set(listId, {
        listId,
        // type：0=自建 / 1=收藏（实测字段为 type，非 list_type）
        type: Number(item.type ?? 0),
        // 条目无 total_ver 字段，写操作按官方实践传 0
        totalVer: Number(item.total_ver ?? 0),
        // 收藏歌单的公开 id：必须用它与公开歌单接口拉歌曲
        globalCollectionId: pickString(item.list_create_gid, item.global_collection_id),
      })
    }
    return raw
  }

  private mapPlaylist(item: JsonObject, userId: string): PlatformPlaylist {
    const id = pickString(item.listid, item.id) ?? ''
    // 收藏歌单的原 specialid 可用于拼接旧版网页链接；自建歌单 specialid 为 0，没有对应网页
    const specialId = pickString(item.from_listid, item.list_create_listid)
    // 新版分享标识：encode_gcid/gcid 字段，值形如 gcid_3zco8lfbz7z0f8（自建与收藏歌单都有）。
    // 官方分享页 https://www.kugou.com/songlist/{gcid}/ 在 PC 可正常展示（实测 m.kugou.com 链接重定向到此），
    // 但页面依赖四个查询参数缺一不可（实测逐个删减均渲染空白）：src_cid（gcid 去前缀）、
    // uid（歌单创建者）、chl=link、iszlist=1；拼不齐时回退旧链接。
    // 注意旧字段 list_create_gid/global_collection_id 是 collection_3_xxx 格式，不能用于 songlist URL。
    const gcid = pickString(item.encode_gcid, item.gcid)
    const shareUrl = buildSonglistShareUrl(gcid, item, userId)
    return {
      id,
      name: pickString(item.name) ?? '未命名歌单',
      songCount: Number(item.count ?? item.source_count ?? 0),
      // 封面 URL 带 {size} 占位符（如 c1.kgimg.com/stdmusic/{size}/...），必须替换才能直接加载
      coverUrl: normalizeCover(pickString(item.pic, item.imgurl, item.cover), '300'),
      // appUrl 不填：酷狗 PC 客户端无公开 URL scheme 文档，无法可靠唤起客户端，webUrl 已覆盖浏览器打开
      webUrl:
        shareUrl ??
        (specialId
          ? `https://www.kugou.com/yy/special/single/${specialId}.html`
          : buildOwnPlaylistShareUrl(userId, id)),
      ownerId: pickString(item.list_create_userid, item.create_userid, userId),
      extraIds: Object.fromEntries(
        Object.entries({
          gcid,
          globalCollectionId: pickString(item.list_create_gid, item.global_collection_id),
          specialId,
          type: item.type === undefined ? undefined : String(Number(item.type)),
          totalVer: item.total_ver === undefined ? undefined : String(Number(item.total_ver)),
        }).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
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
    this.log.debug('playlist.songs', '歌曲拉取路径决策', {
      playlistId,
      type: meta.type,
      globalCollectionId: meta.globalCollectionId,
    })
    let items: JsonObject[]
    if (meta.type === 1 && meta.globalCollectionId) {
      // 收藏歌单：按 list_create_gid/global_collection_id 走公开歌单接口（listid 拉不到）
      items = await this.fetchTrackAll(credential, meta.globalCollectionId)
      if (items.length === 0) {
        // 公开接口对部分歌单返回空（如新版 gcid 体系歌单），回退云歌单接口按 listid 再试
        this.log.warn('playlist.songs', '公开歌单接口返回空，回退云歌单接口', {
          playlistId,
          globalCollectionId: meta.globalCollectionId,
        })
        items = await this.fetchTrackAllNew(credential, playlistId, meta.type)
      }
    } else {
      // 自建歌单：云歌单接口按 listid
      items = await this.fetchTrackAllNew(credential, playlistId, meta.type)
      if (items.length === 0 && meta.globalCollectionId) {
        // 云歌单接口覆盖不到时回退公开歌单接口
        this.log.warn('playlist.songs', '云歌单接口返回空，回退公开歌单接口', { playlistId })
        items = await this.fetchTrackAll(credential, meta.globalCollectionId)
      }
    }
    if (items.length === 0) {
      this.log.warn('playlist.songs', '两个接口均未返回歌曲，请检查歌单条目字段', {
        playlistId,
        type: meta.type,
        globalCollectionId: meta.globalCollectionId,
      })
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
    if (raw.length > 0) {
      this.log.info('playlist.songs', '歌曲条目原始字段采样', { sample: raw[0] })
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
      // 公开接口的歌曲在 songs 字段（实测 get_other_list_file_nofilt 返回 data.songs，
      // 无 info 字段）；songs 混有 {fileid, shield} 屏蔽位条目，按缺 hash 过滤
      const songs = asArray(data.songs)
        .map((s) => asObject(s))
        .filter((s) => Boolean(pickString(s.hash)))
      raw.push(...songs)
      const total = typeof data.count === 'number' ? data.count : undefined
      if (songs.length < pageSize || (total !== undefined && raw.length >= total)) break
    }
    return raw
  }

  /** 歌单内歌曲条目 → 领域模型，同时缓存加歌/删歌元数据 */
  private mapPlaylistSong(item: JsonObject): PlatformSong {
    const hash = (pickString(item.hash, item.file_hash, item.song_hash) ?? '').toLowerCase()
    // 云歌单条目无独立歌名/歌手：name 为「歌手 - 标题.mp3」格式，singerinfo 为歌手数组
    const parsed = splitKgFilename(pickString(item.name, item.filename) ?? '')
    const singerInfo = artistNames(asArray(item.singerinfo ?? item.singer_info))
    const title = pickString(item.title, item.songname) ?? parsed.title
    const artist =
      singerInfo ||
      parsed.artist ||
      pickString(item.singer, item.singername, item.author) ||
      ''
    const trans = asObject(item.trans_param)
    const albuminfo = asObject(item.albuminfo)
    if (hash) {
      this.songMeta.set(hash, {
        name: title || '未知歌曲',
        albumId: typeof item.album_id === 'number' ? item.album_id : Number(item.album_id ?? 0),
        mixSongId: typeof item.mixsongid === 'number' ? item.mixsongid : Number(item.mixsongid ?? 0),
        fileId: pickString(item.fileid, item.file_id),
      })
    }
    return {
      id: hash,
      title: title || '未知歌曲',
      artist,
      // 专辑名在 albuminfo.name（实测云歌单条目唯一携带专辑名的位置）
      album: pickString(albuminfo.name, item.album_name, item.albumname),
      coverUrl:
        normalizeCover(pickString(item.cover, trans.union_cover, item.img, item.pic)) ??
        hashCover(hash),
      durationMs:
        typeof item.timelen === 'number'
          ? normalizeKgTimelen(item.timelen)
          : saneDuration(typeof item.duration === 'number' ? item.duration * 1000 : Number.NaN),
      identifiers: compactIdentifiers({
        // 云歌单条目歌手 id：singerinfo 元素带 id 字段时取之；SingerId 数组兜底（字段名多键容错）
        singerIds: toIdList(item.SingerId) ?? toIdList(item.singerinfo ?? item.singer_info),
        fileId: this.songMeta.get(hash)?.fileId,
        mixSongId: toIdString(this.songMeta.get(hash)?.mixSongId),
        albumId: toIdString(this.songMeta.get(hash)?.albumId),
      }),
    }
  }

  // ==============================
  // 实体面板原语（歌手歌曲/专辑曲目）：android 加密 + 设备指纹即可读
  // （KUGOU_API_MID 是设备指纹而非登录态，buildCookie 未登录也注入；
  //  读接口 cookie 参数可选，匿名可用）。字段契约 📐 源码 + 多键容错。
  // ==============================

  readonly encyclopedia: PlatformEncyclopedia = {
    search: async (kind: EncyclopediaKind, name: string, credential?: string) => {
      return this.searchEncyclopedia(kind, name, credential ?? '')
    },
    detail: async (
      kind: EncyclopediaKind,
      id: string,
      name?: string,
      credential?: string,
    ) => {
      return this.fetchPanelContent(kind, id, name, credential ?? '')
    },
  }

  private async searchEncyclopedia(
    kind: EncyclopediaKind,
    name: string,
    credential: string,
  ): Promise<EncyclopediaCandidate[]> {
    const res = await this.call(this.api.search!, {
      keyword: name,
      type: kind === 'singer' ? 'author' : 'album',
      page: 1,
      pagesize: 20,
      cookie: this.buildCookie(credential),
    })
    const data = asObject(res.data ?? res)
    const raw = asArray(data.lists ?? data.info ?? data.list)
    const list = raw.length > 0 && Array.isArray(raw[0]) ? asArray(raw[0]) : raw
    return list
      .map((rawItem) => {
        const item = asObject(rawItem)
        // 实测：歌手条目为大写驼峰键 AuthorId/AuthorName/Avatar；专辑条目为全小写 albumid/albumname/singer/img
        if (kind === 'singer') {
          const fans = typeof item.FansNum === 'number' ? item.FansNum : Number(item.FansNum ?? 0)
          return {
            id: pickString(item.AuthorId, item.author_id, item.authorid, item.singer_id, item.singerid, item.id) ?? '',
            name: pickString(item.AuthorName, item.author_name, item.authorname, item.singer_name, item.singername, item.name) ?? '',
            picUrl: normalizeCover(pickString(item.Avatar, item.sizable_avatar, item.avatar, item.pic, item.img, item.image)),
            ...(Number.isFinite(fans) && fans > 0 ? { followerCount: fans } : {}),
          }
        }
        return {
          id: pickString(item.albumid, item.album_id, item.id) ?? '',
          name: pickString(item.albumname, item.album_name, item.name) ?? '',
          picUrl: normalizeCover(pickString(item.img, item.sizable_cover, item.cover, item.pic, item.image)),
          // 专辑候选附歌手名，帮助同名专辑消歧
          singer: pickString(item.singer, item.singername, item.author_name, item.authorname),
        }
      })
      // 无 id 或上游记 0 的残缺条目无法点选确认，直接过滤
      .filter((c) => c.id !== '' && c.id !== '0')
  }

  private async fetchPanelContent(
    kind: EncyclopediaKind,
    id: string,
    name: string | undefined,
    credential: string,
  ): Promise<EncyclopediaContent> {
    if (kind === 'singer') return this.fetchSingerSongs(id, name, credential)
    return this.fetchAlbumTracks(id, name, credential)
  }

  /**
   * 歌手的歌：/kmr/v1/audio_group/author（sort=hot 最热）；实测：顶层 { total, error_code, data: [...] }，
   * data 直接是歌曲数组。该接口不带歌手头像：按名字搜索一次歌手补 Avatar（失败静默，仅无图）。
   */
  private async fetchSingerSongs(
    id: string,
    name: string | undefined,
    credential: string,
  ): Promise<EncyclopediaContent> {
    const res = await this.call(this.api.artist_audios!, {
      id,
      page: 1,
      pagesize: 30,
      sort: 'hot',
      cookie: this.buildCookie(credential),
    })
    const raw = asArray(res.data)
    const songs = raw.map((rawItem) => this.withSongUrl(this.mapPanelSong(asObject(rawItem))))
    let imageUrl: string | undefined
    if (name?.trim()) {
      const candidates = await this.searchEncyclopedia('singer', name, credential).catch(() => [])
      imageUrl = (candidates.find((c) => c.id === id) ?? candidates[0])?.picUrl
    }
    return {
      kind: 'singer',
      id,
      name: songs[0]?.artist ?? '',
      songs,
      imageUrl,
      source: 'kugou',
      sourceUrl: `https://www.kugou.com/singer/${encodeURIComponent(id)}.html`,
    }
  }

  /** 专辑曲目：专辑详情（publish_date）+ 专辑音乐列表并行 */
  private async fetchAlbumTracks(
    id: string,
    name: string | undefined,
    credential: string,
  ): Promise<EncyclopediaContent> {
    const [detailRes, songsRes] = await Promise.all([
      this.call(this.api.album_detail!, { id, cookie: this.buildCookie(credential) }).catch(
        () => null,
      ),
      this.call(this.api.album_songs!, {
        id,
        page: 1,
        pagesize: 50,
        cookie: this.buildCookie(credential),
      }).catch(() => null),
    ])
    const detailData = asObject(asObject(detailRes).data ?? detailRes)
    const album = asObject(
      Array.isArray(detailData) ? asArray(detailData)[0] : detailData,
    )
    const songsData = asObject(asObject(songsRes).data ?? songsRes)
    const raw = asArray(songsData.list ?? songsData.lists ?? songsData.songs ?? songsData.audios)
    const songs = raw.map((rawItem) => this.withSongUrl(this.mapPanelSong(asObject(rawItem))))
    return {
      kind: 'album',
      id,
      name:
        pickString(album.album_name, album.albumname, album.name) ?? name ?? '',
      releaseDate: normalizeReleaseDate(pickString(album.publish_date, album.publishDate)),
      songs,
      imageUrl: normalizeCover(pickString(album.sizable_cover, album.cover, album.pic, album.img)),
      source: 'kugou',
      sourceUrl: `https://www.kugou.com/album/${encodeURIComponent(id)}.html`,
    }
  }

  /** 面板曲目附歌曲页跳转：酷狗歌曲页用 hash（与 songDetail 一致），缺失 id 时不提供 */
  private withSongUrl(song: PlatformSong): EncyclopediaTrack {
    return attachSongUrl(song, (s) => (s.id ? songWebUrl.kugou(s.id) : undefined))
  }

  /**
   * 面板歌曲条目（实测 artist_audios/album_songs 同形）：
   * hash 为 32 位大写 → 统一小写作 id（与搜索/歌单歌曲一致）；
   * 歌手字段是 author_name、时长为 timelength（毫秒）。
   */
  private mapPanelSong(item: JsonObject): PlatformSong {
    const hash = (pickString(item.hash, item.hash_32, item.filehash, item.FileHash) ?? '').toLowerCase()
    const title = stripHighlightTags(
      pickString(item.audio_name, item.audioName, item.song_name, item.songname, item.name) ??
        '未知歌曲',
    )
    return {
      id: hash || pickString(item.audio_id, item.audioId, item.album_audio_id, item.rid, item.id) || '',
      title,
      artist: pickString(item.author_name, item.authorname, item.singer_name, item.singername, item.singer) ?? '',
      album: pickString(item.album_name, item.albumname),
      durationMs: saneDuration(
        typeof item.timelength === 'number' && item.timelength > 0
          ? item.timelength
          : typeof item.playtime === 'number' && item.playtime > 0
            ? (item.playtime > 10_000 ? item.playtime : item.playtime * 1000)
            : Number.NaN,
      ),
    }
  }

  // ==============================
  // 歌曲详情补充：酷狗无公开歌词 id 来源（lyric 接口需歌词 id + accesskey），
  // 只提供平台跳转；歌词/发行时间保持静默缺失。
  // ==============================

  readonly songDetail: PlatformSongDetail = {
    detail: async (songId) => ({
      webUrl: songWebUrl.kugou(songId),
    }),
  }

  // --- 搜索 ---

  protected async doSearch(
    credential: string,
    keyword: string,
    limit: number,
    page = 1,
  ): Promise<PlatformSong[]> {
    try {
      const res = await this.call(this.api.search!, {
        keyword,
        page,
        pagesize: limit,
        cookie: this.buildCookie(credential),
      })
      const data = asObject(res.data ?? res)
      // v2/search/song 实测：data.lists 是歌曲对象数组（flat）；
      // 部分协议版本为嵌套数组（lists[0] 是歌曲数组），两者兼容
      const raw = asArray(data.lists)
      const list = raw.length > 0 && Array.isArray(raw[0]) ? asArray(raw[0]) : raw
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
      coverUrl:
        normalizeCover(pickString(item.Image, item.img, item.pic)) ?? hashCover(hash),
      durationMs: saneDuration(
        typeof item.Duration === 'number' ? item.Duration * 1000 : Number.NaN,
      ),
      identifiers: compactIdentifiers({
        // 实测：v2/search/song 条目带 SingerId 数字数组（[3520]）→ 点歌手名按 id 直达，无同名歧义
        singerIds: toIdList(item.SingerId),
        mixSongId: toIdString(this.songMeta.get(hash)?.mixSongId),
        albumId: toIdString(this.songMeta.get(hash)?.albumId),
      }),
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
    // 实测 v5/add_list 部分协议版本不返回 listid（歌单实际已创建）：
    // 响应字段先采样记录，解析失败时回读歌单列表按名称兜底找回 id
    const id = pickString(data.listid, data.list_id, data.id, res.listid)
    if (!id || id === '0') {
      this.log.warn('playlist.create-no-id', '建单响应未携带歌单 id，回读列表兜底', {
        name: trimmed,
        sample: res,
      })
      // 平台列表可能有秒级同步延迟：未找到时稍等重试一次
      let rows = await this.fetchPlaylistItems(credential)
      let hit = rows.find((r) => pickString(r.name, r.specialname)?.trim() === trimmed)
      if (!hit) {
        await new Promise((resolve) => setTimeout(resolve, 800))
        rows = await this.fetchPlaylistItems(credential)
        hit = rows.find((r) => pickString(r.name, r.specialname)?.trim() === trimmed)
      }
      const fallbackId = hit ? pickString(hit.listid, hit.id) : undefined
      if (!fallbackId) {
        this.log.error('playlist.create-fallback-miss', '回读列表未找到刚创建的歌单', {
          name: trimmed,
          sample: rows.slice(0, 3).map((r) => pickString(r.name, r.specialname)),
        })
        throw new Error('酷狗：创建歌单失败（接口未返回歌单 id）')
      }
      this.playlistIndex.set(fallbackId, { listId: fallbackId, type: 0, totalVer: 0 })
      return fallbackId
    }
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
    icon: 'music_note',
    capabilities: { read: true, write: true, encyclopedia: true },
  },
  createAdapter: (ctx) => {
    // 重依赖懒加载：测试环境 import 本模块不会触发 require
    const api = createRequire(import.meta.url)('kugoumusicapi') as KugouApi
    const device = loadKugouDevice(ctx.userDataDir)
    return new KugouAdapter(api, device, ctx.userDataDir)
  },
}

export default kugouModule
