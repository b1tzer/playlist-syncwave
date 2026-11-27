/**
 * 实体面板领域模型：点击歌手名/专辑名弹出「歌手歌曲 / 专辑曲目」面板所需的数据结构。
 * 渲染层、主进程、平台适配器三层共用（core 层不依赖 Electron）。
 */
import type { PlatformSong } from './platform'

/** 实体类型：歌手、专辑（歌曲名点击走渲染层本地「歌曲详情卡」，不进本模型） */
export type EncyclopediaKind = 'singer' | 'album'

/** 渲染层发起的百科查询请求 */
export interface EncyclopediaQuery {
  platform: string
  kind: EncyclopediaKind
  /** 展示名（搜索与映射缓存键使用） */
  name: string
  /** 已知实体 id（歌曲数据自带歌手/专辑 id 时直达详情，跳过搜索） */
  id?: string
  /** 专辑定位备用字段：各平台详情接口所需 id 形态不同（QQ 用 albummid、网易用数字 id），由服务层按平台选取 */
  albumId?: string
  albumMid?: string
  /** 强制重新搜索候选（「换一个」纠偏入口），跳过映射与 id 直达 */
  forceSearch?: boolean
}

/** 搜索返回的实体候选（同名消歧由主进程打分排序） */
export interface EncyclopediaCandidate {
  id: string
  name: string
  /** 别名/外文名，用于消歧匹配与展示 */
  aliases?: string[]
  picUrl?: string
  /** 专辑候选的歌手名，帮助同名专辑消歧与展示 */
  singer?: string
  /** 粉丝数/热度，同名候选热度高者优先 */
  followerCount?: number
}

/** 面板曲目：平台歌曲 + 歌曲页跳转链接（提供时渲染层可点击跳平台） */
export type EncyclopediaTrack = PlatformSong & { webUrl?: string }

/** 实体面板内容：歌手 → 歌手歌曲清单；专辑 → 发行时间 + 专辑曲目清单 */
export interface EncyclopediaContent {
  kind: EncyclopediaKind
  /** 实体 id（展示与纠偏回写使用） */
  id: string
  name: string
  /** 专辑发行时间（yyyy-MM-dd）；歌手面板无此字段 */
  releaseDate?: string
  /** 歌手的歌 / 专辑曲目（按平台热门/曲目顺序） */
  songs?: EncyclopediaTrack[]
  imageUrl?: string
  /** 内容来源平台 id，渲染层据此显示来源标识 */
  source: string
  /** 在浏览器打开的原始页面链接 */
  sourceUrl?: string
}

/** lookup 的判别联合返回：内容直达 / 需要用户点选候选 / 平台不支持 / 无内容 */
export type EncyclopediaLookupResult =
  | { status: 'content'; content: EncyclopediaContent }
  | { status: 'candidates'; candidates: EncyclopediaCandidate[] }
  | { status: 'unsupported' }
  | { status: 'empty' }

/** 用户选定候选后写入「名字 → 实体 id」映射的请求 */
export interface EncyclopediaConfirmRequest {
  platform: string
  kind: EncyclopediaKind
  name: string
  entityId: string
  entityName: string
}
