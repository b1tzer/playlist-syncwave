import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import { createLogger, type Logger } from '@core/logging'

/**
 * 各音乐平台适配器需要实现的统一接口。core 层只依赖此接口。
 */
export interface PlatformAdapter {
  readonly platform: string

  /** 创建二维码登录票据；channel 由平台自定（如 QQ音乐的 qqmusic/wechat/qq） */
  createQrLogin(channel?: string): Promise<QrLoginTicket>

  /** 轮询二维码登录状态 */
  checkQrLogin(key: string): Promise<QrLoginResult>

  /** 用 cookie 换取账号信息；未登录返回 null */
  getLoginStatus(cookie: string): Promise<PlatformAccount | null>

  /**
   * 凭证保活：校验登录态是否仍有效，续期成功时返回新凭证。
   * 定时后台任务调用；网络波动等异常不应误判失效。
   */
  keepAlive(credential: string): Promise<KeepAliveResult>

  /** 拉取用户歌单列表 */
  getUserPlaylists(cookie: string, userId: string): Promise<PlatformPlaylist[]>

  /** 拉取歌单内的歌曲 */
  getPlaylistSongs(cookie: string, playlistId: string): Promise<PlatformSong[]>

  /** 按关键词搜索歌曲（供匹配引擎使用；page 从 1 起，供滚动分页） */
  searchSongs(cookie: string, keyword: string, limit?: number, page?: number): Promise<PlatformSong[]>

  /** 创建歌单，返回新歌单 ID */
  createPlaylist(cookie: string, name: string): Promise<string>

  /** 批量添加歌曲到歌单 */
  addSongsToPlaylist(cookie: string, playlistId: string, songIds: string[]): Promise<void>

  /** 重命名歌单 */
  renamePlaylist(cookie: string, playlistId: string, name: string): Promise<void>

  /** 删除歌单 */
  deletePlaylist(cookie: string, playlistId: string): Promise<void>

  /** 从歌单移除歌曲 */
  removeSongsFromPlaylist(cookie: string, playlistId: string, songIds: string[]): Promise<void>

  /**
   * 网页登录完成回调（可选）：主进程从登录窗口 cookie 提取会话值后调用，
   * 平台据此补全其余凭证（如 Apple Music 抓取 developer token）并返回完整凭证串。
   * 未实现时主进程直接以会话值作为凭证保存。
   */
  webLoginSetup?(sessionValue: string): Promise<string>
}

function unsupported(platform: string, method: string): Error {
  return new Error(`平台 ${platform} 不支持操作：${method}`)
}

/** 扫码轮询原始状态：code 语义与各平台一致（800 过期 / 802 已扫 / 803 成功） */
export interface QrCheckRaw {
  code: number | undefined
  /** 状态为 803 时的登录 cookie */
  cookie?: string
}

/** 登录状态原始字段（字段缺失时骨架返回 null / 使用默认昵称） */
export interface LoginStatusRaw {
  userId?: string
  nickname?: string
}

/** 保活结果：模板方法与平台原语共用，主进程据此更新凭证或清除登录态 */
export interface KeepAliveResult {
  /** 凭证是否仍有效（false 表示登录态已失效） */
  alive: boolean
  /** 续期后的新凭证；凭证无变化时为 undefined */
  cookie?: string
}

/**
 * 平台适配器基类（模板方法模式）：
 *
 * 模板方法（public）定义跨平台一致的流程骨架——
 * 扫码状态机（800/802/803）、错误提示、耗时统计与统一日志，
 * 各平台只需实现平台差异的「原语」（protected abstract 方法）：
 * 接口调用方式、响应字段路径与领域模型映射。
 *
 * 写能力原语默认抛「不支持」，按 PlatformMeta.capabilities 声明覆写即可。
 */
export abstract class BasePlatformAdapter implements PlatformAdapter {
  /** 平台唯一 id（与 PlatformMeta.id 一致） */
  abstract readonly platform: string

  /** 平台中文名：用于错误提示前缀 */
  protected abstract readonly platformLabel: string

  private _log?: Logger

  /** 实例级日志（module = platform.<id>，懒创建） */
  protected get log(): Logger {
    if (!this._log) this._log = createLogger({ module: `platform.${this.platform}` })
    return this._log
  }

  // ==============================
  // 模板方法（流程骨架固定，勿覆写）
  // ==============================

  async createQrLogin(channel?: string): Promise<QrLoginTicket> {
    return this.log.time('login.qr.create', async () => {
      const key = await this.qrCreateKey(channel)
      const qrBase64 = await this.qrBuildImage(key)
      if (!qrBase64) throw new Error(`${this.platformLabel}：生成二维码失败`)
      this.log.info('login.qr.create', '二维码票据生成成功', channel ? { key, channel } : { key })
      return { key, qrBase64 }
    })
  }

  async checkQrLogin(key: string): Promise<QrLoginResult> {
    // 轮询接口高频调用，完成日志降为 debug，仅在状态变化时记录 info/warn
    return this.log.time(
      'login.qr.check',
      async () => {
        const raw = await this.qrCheckStatus(key)
        switch (raw.code) {
          case 800:
            this.log.warn('login.qr.check', '二维码已过期', { key })
            return { status: 'expired' }
          case 802:
            return { status: 'scanned' }
          case 803:
            this.log.info('login.qr.check', '扫码确认成功', { key })
            return { status: 'success', cookie: raw.cookie }
          default:
            return { status: 'waiting' }
        }
      },
      undefined,
      'debug',
    )
  }

  async getLoginStatus(credential: string): Promise<PlatformAccount | null> {
    return this.log.time('login.status', async () => {
      const raw = await this.fetchLoginStatus(credential)
      if (!raw.userId) return null
      const nickname = raw.nickname ?? '未知用户'
      this.log.debug('login.status', '查询登录状态', { userId: raw.userId, nickname })
      return { platform: this.platform, userId: raw.userId, nickname }
    })
  }

  async keepAlive(credential: string): Promise<KeepAliveResult> {
    // 定时后台任务，完成日志降为 debug
    return this.log.time(
      'keepalive.check',
      async () => {
        try {
          const result = await this.doKeepAlive(credential)
          if (!result.alive) {
            this.log.warn('keepalive.check', '凭证已失效')
          } else if (result.cookie) {
            this.log.info('keepalive.check', '凭证保活成功，已续期')
          } else {
            this.log.debug('keepalive.check', '凭证保活校验通过')
          }
          return result
        } catch (e) {
          // 网络波动等异常不应误判失效：保持现状，等待下一轮重试
          this.log.warn('keepalive.check', '保活检查失败，保持现状', {
            message: e instanceof Error ? e.message : String(e),
          })
          return { alive: true }
        }
      },
      undefined,
      'debug',
    )
  }

  async getUserPlaylists(credential: string, userId: string): Promise<PlatformPlaylist[]> {
    return this.log.time('playlist.list', async () => {
      const playlists = await this.fetchPlaylists(credential, userId)
      this.log.info('playlist.list', '拉取歌单列表', { userId, count: playlists.length })
      return playlists
    })
  }

  async getPlaylistSongs(credential: string, playlistId: string): Promise<PlatformSong[]> {
    return this.log.time('playlist.songs', async () => {
      const songs = await this.fetchPlaylistSongs(credential, playlistId)
      this.log.info('playlist.songs', '拉取歌单歌曲', { playlistId, count: songs.length })
      return songs
    })
  }

  async searchSongs(credential: string, keyword: string, limit = 30, page = 1): Promise<PlatformSong[]> {
    // 同步过程中逐首高频调用，完成日志降为 debug
    return this.log.time(
      'search.songs',
      async () => {
        const songs = await this.doSearch(credential, keyword, limit, page)
        this.log.debug('search.songs', '搜索结果', { keyword, page, count: songs.length })
        return songs
      },
      undefined,
      'debug',
    )
  }

  async createPlaylist(credential: string, name: string): Promise<string> {
    return this.log.time('playlist.create', async () => {
      const id = await this.doCreatePlaylist(credential, name)
      if (!id) throw new Error(`${this.platformLabel}：创建歌单失败`)
      this.log.info('playlist.create', '创建歌单成功', { playlistId: id, name })
      return id
    })
  }

  async addSongsToPlaylist(credential: string, playlistId: string, songIds: string[]): Promise<void> {
    return this.log.time('playlist.add-songs', async () => {
      if (songIds.length === 0) return
      await this.doAddSongs(credential, playlistId, songIds)
      this.log.info('playlist.add-songs', '批量添加歌曲成功', { playlistId, count: songIds.length })
    })
  }

  async renamePlaylist(credential: string, playlistId: string, name: string): Promise<void> {
    return this.log.time('playlist.rename', async () => {
      await this.doRenamePlaylist(credential, playlistId, name)
      this.log.info('playlist.rename', '重命名歌单成功', { playlistId, name })
    })
  }

  async deletePlaylist(credential: string, playlistId: string): Promise<void> {
    return this.log.time('playlist.delete', async () => {
      await this.doDeletePlaylist(credential, playlistId)
      this.log.info('playlist.delete', '删除歌单成功', { playlistId })
    })
  }

  async removeSongsFromPlaylist(
    credential: string,
    playlistId: string,
    songIds: string[],
  ): Promise<void> {
    return this.log.time('playlist.remove-songs', async () => {
      if (songIds.length === 0) return
      await this.doRemoveSongs(credential, playlistId, songIds)
      this.log.info('playlist.remove-songs', '移除歌曲成功', { playlistId, count: songIds.length })
    })
  }

  // ==============================
  // 读能力原语（abstract，各平台必须实现）
  // ==============================

  /** 获取二维码登录 key；失败抛平台错误 */
  protected abstract qrCreateKey(channel?: string): Promise<string>

  /** 用 key 生成二维码图片（base64）；返回 undefined 表示生成失败 */
  protected abstract qrBuildImage(key: string): Promise<string | undefined>

  /** 轮询一次扫码状态，返回原始 code 与（成功时）cookie */
  protected abstract qrCheckStatus(key: string): Promise<QrCheckRaw>

  /** 查询账号信息；未登录时 userId 缺失 */
  protected abstract fetchLoginStatus(credential: string): Promise<LoginStatusRaw>

  /** 拉取并过滤、映射歌单列表（特殊收藏夹过滤等平台规则在此实现） */
  protected abstract fetchPlaylists(credential: string, userId: string): Promise<PlatformPlaylist[]>

  /** 拉取并映射歌单歌曲 */
  protected abstract fetchPlaylistSongs(credential: string, playlistId: string): Promise<PlatformSong[]>

  /** 执行平台搜索并映射为领域模型（平台错误分类/可重试判定在此实现；page 从 1 起） */
  protected abstract doSearch(
    credential: string,
    keyword: string,
    limit: number,
    page?: number,
  ): Promise<PlatformSong[]>

  // ==============================
  // 保活原语（默认仅校验登录态，平台可覆写实现真正续期）
  // ==============================

  /**
   * 保活原语：默认通过查询登录态校验凭证是否仍有效（不做续期）。
   * 平台可覆写实现真正续期（如 login_refresh），续期成功后返回新 cookie。
   */
  protected async doKeepAlive(credential: string): Promise<KeepAliveResult> {
    const raw = await this.fetchLoginStatus(credential)
    return { alive: Boolean(raw.userId) }
  }

  // ==============================
  // 写能力原语（默认不支持，按 capabilities 覆写）
  // ==============================

  protected doCreatePlaylist(_credential: string, _name: string): Promise<string> {
    return Promise.reject(unsupported(this.platform, 'createPlaylist'))
  }

  protected doAddSongs(
    _credential: string,
    _playlistId: string,
    _songIds: string[],
  ): Promise<void> {
    return Promise.reject(unsupported(this.platform, 'addSongsToPlaylist'))
  }

  protected doRenamePlaylist(
    _credential: string,
    _playlistId: string,
    _name: string,
  ): Promise<void> {
    return Promise.reject(unsupported(this.platform, 'renamePlaylist'))
  }

  protected doDeletePlaylist(_credential: string, _playlistId: string): Promise<void> {
    return Promise.reject(unsupported(this.platform, 'deletePlaylist'))
  }

  protected doRemoveSongs(
    _credential: string,
    _playlistId: string,
    _songIds: string[],
  ): Promise<void> {
    return Promise.reject(unsupported(this.platform, 'removeSongsFromPlaylist'))
  }
}
