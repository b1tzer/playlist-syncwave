/** 本地歌单：登录前/未匹配时暂存歌曲草稿，可后续同步到任意平台 */
export interface LocalPlaylist {
  id: string
  name: string
  songCount: number
  createdAt: string
  updatedAt: string
}

export interface LocalPlaylistSong {
  /** 歌单内序号（0 起） */
  id: number
  title: string
  artist: string
  album?: string
  durationMs?: number
}
