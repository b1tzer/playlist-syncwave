export interface PlatformSong {
  /** 平台歌曲 ID */
  id: string
  title: string
  artist: string
  album?: string
  durationMs?: number
}

export interface PlatformPlaylist {
  /** 平台歌单 ID */
  id: string
  name: string
  songCount: number
  coverUrl?: string
}

export interface PlatformAccount {
  platform: string
  userId: string
  nickname: string
}

export type QrLoginStatus = 'waiting' | 'scanned' | 'expired' | 'success'

export interface QrLoginTicket {
  key: string
  /** base64 编码的二维码图片 */
  qrBase64: string
}

export interface QrLoginResult {
  status: QrLoginStatus
  /** status 为 success 时的登录 cookie */
  cookie?: string
}
