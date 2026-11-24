import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'

/** 各音乐平台适配器需要实现的统一接口。core 层只依赖此接口。 */
export interface PlatformAdapter {
  readonly platform: string

  /** 创建二维码登录票据；channel 由平台自定（如 QQ音乐的 qqmusic/wechat/qq） */
  createQrLogin(channel?: string): Promise<QrLoginTicket>

  /** 轮询二维码登录状态 */
  checkQrLogin(key: string): Promise<QrLoginResult>

  /** 用 cookie 换取账号信息；未登录返回 null */
  getLoginStatus(cookie: string): Promise<PlatformAccount | null>

  /** 拉取用户歌单列表 */
  getUserPlaylists(cookie: string, userId: string): Promise<PlatformPlaylist[]>

  /** 拉取歌单内的歌曲 */
  getPlaylistSongs(cookie: string, playlistId: string): Promise<PlatformSong[]>

  /** 按关键词搜索歌曲（供匹配引擎使用） */
  searchSongs(cookie: string, keyword: string, limit?: number): Promise<PlatformSong[]>

  /** 创建歌单，返回新歌单 ID */
  createPlaylist(cookie: string, name: string): Promise<string>

  /** 批量添加歌曲到歌单 */
  addSongsToPlaylist(cookie: string, playlistId: string, songIds: string[]): Promise<void>
}

function unsupported(platform: string, method: string): Error {
  return new Error(`平台 ${platform} 不支持操作：${method}`)
}

/**
 * 平台适配器基类：所有方法默认抛「不支持」错误。
 * 新增平台只需继承本类并 override 实际支持的能力
 * （配合 PlatformMeta.capabilities 声明，渲染层不会调用未声明的能力）。
 */
export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: string

  createQrLogin(_channel?: string): Promise<QrLoginTicket> {
    return Promise.reject(unsupported(this.platform, 'createQrLogin'))
  }

  checkQrLogin(_key: string): Promise<QrLoginResult> {
    return Promise.reject(unsupported(this.platform, 'checkQrLogin'))
  }

  getLoginStatus(_cookie: string): Promise<PlatformAccount | null> {
    return Promise.reject(unsupported(this.platform, 'getLoginStatus'))
  }

  getUserPlaylists(_cookie: string, _userId: string): Promise<PlatformPlaylist[]> {
    return Promise.reject(unsupported(this.platform, 'getUserPlaylists'))
  }

  getPlaylistSongs(_cookie: string, _playlistId: string): Promise<PlatformSong[]> {
    return Promise.reject(unsupported(this.platform, 'getPlaylistSongs'))
  }

  searchSongs(_cookie: string, _keyword: string, _limit?: number): Promise<PlatformSong[]> {
    return Promise.reject(unsupported(this.platform, 'searchSongs'))
  }

  createPlaylist(_cookie: string, _name: string): Promise<string> {
    return Promise.reject(unsupported(this.platform, 'createPlaylist'))
  }

  addSongsToPlaylist(_cookie: string, _playlistId: string, _songIds: string[]): Promise<void> {
    return Promise.reject(unsupported(this.platform, 'addSongsToPlaylist'))
  }
}
