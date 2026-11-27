import type { PlatformSongIdentifiers } from './platform'

/**
 * 歌曲详情（点击歌名弹出的详情卡异步补充层）：
 * 身份信息（标题/歌手/专辑/封面/时长）由渲染层本地渲染，
 * 歌词/发行时间/平台跳转由主进程按平台接口补充，失败静默保持 undefined。
 */
export interface SongDetailRequest {
  platform: string
  songId: string
  /** 次级标识：QQ 歌词需 songMid、发行时间需 albumMid；网易云用数字 songId */
  identifiers?: PlatformSongIdentifiers
  /** 歌曲名/歌手：QQ 在次级标识缺失（旧缓存/旧本地数据）时按名字搜索兜底定位 */
  title?: string
  artist?: string
}

export interface SongDetailData {
  /** 歌词原文（LRC 或纯文本行），渲染层剥离时间戳展示；无歌词/纯音乐为 undefined */
  lyrics?: string
  /** 发行时间（yyyy-MM-dd 归一化，取不到时 undefined） */
  releaseDate?: string
  /** 在平台打开的歌曲页（https） */
  webUrl?: string
}
