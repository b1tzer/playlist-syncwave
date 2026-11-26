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
  /** 来源歌单封面（导入时复制；只接受 https） */
  coverUrl?: string
}

/** 本地歌单与某个平台歌单的关联（一个本地歌单可对应多个平台歌单） */
export interface LocalPlaylistSource {
  platform: string
  playlistId: string
  webUrl?: string
  appUrl?: string
  ownerId?: string
  extraIds?: Record<string, string>
  coverUrl?: string
  /** 最近一次从该来源增量同步的时间（ISO 字符串） */
  lastSyncedAt?: string
}

/** 平台歌单同步到本地的结果 */
export interface LocalPlaylistSyncResult {
  playlist: LocalPlaylist
  created: boolean
  added: number
  updated: number
}

/** 本地歌单：登录前/未匹配时暂存歌曲草稿，可后续同步到任意平台 */
export interface LocalPlaylist {
  id: string
  name: string
  songCount: number
  createdAt: string
  updatedAt: string
  origin?: LocalPlaylistOrigin
  /** 歌单封面 URL（平台导入复制 / 手工歌单取第一首歌封面；只接受 https） */
  coverUrl?: string
  /** 封面来源：平台歌单复制或歌曲派生 */
  coverSource?: 'platform' | 'song'
  /** 该本地歌单已关联的平台来源（v9 起，多来源） */
  sources?: LocalPlaylistSource[]
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
  /** 歌曲封面 URL（只接受 https） */
  coverUrl?: string
}
