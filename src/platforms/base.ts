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
