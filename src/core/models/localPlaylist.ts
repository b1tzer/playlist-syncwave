import type { PlatformSongIdentifiers } from './platform'

/** 平台歌单导出到本地时保留的来源定位信息（手工创建的本地歌单无此字段） */
export interface LocalPlaylistOrigin {
  platform: string
  playlistId: string
  webUrl?: string
  appUrl?: string
  /** 账号/创建者 id（QQ uin、网易云 userId、Apple storefront 等） */
  ownerId?: string
  /** 平台专有定位字段（酷狗 gcid/global_collection_id/specialid 等） */
  extraIds?: Record<string, string>
}

/** 本地歌单：登录前/未匹配时暂存歌曲草稿，可后续同步到任意平台 */
export interface LocalPlaylist {
  id: string
  name: string
  songCount: number
  createdAt: string
  updatedAt: string
  origin?: LocalPlaylistOrigin
}

export interface LocalPlaylistSong {
  /** 歌单内序号（0 起） */
  id: number
  title: string
  artist: string
  album?: string
  durationMs?: number
  /** 来源平台与平台歌曲 id（平台歌单导出时写入） */
  sourcePlatform?: string
  sourceSongId?: string
  /** 平台次级唯一标识，尽可能保留用于跨平台匹配 */
  identifiers?: PlatformSongIdentifiers
}
