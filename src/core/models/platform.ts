/**
 * 平台歌曲的次级唯一标识：主 id 之外，上游可用于交叉校验/定位同一首歌的字段。
 * 各平台按实际能力填写，缺失字段保持 undefined；不虚构 ISRC（国内平台当前不暴露）。
 */
export interface PlatformSongIdentifiers {
  albumId?: string
  /** 歌手 id（多歌手时为数组，与 artist 文本顺序一致）；供百科查询直达详情、避免同名搜索 */
  singerIds?: string[]
  /** QQ 音乐歌曲 mid */
  songMid?: string
  /** QQ 音乐专辑 mid */
  albumMid?: string
  /** 酷狗云歌单条目 id（删除歌曲时使用） */
  fileId?: string
  /** 酷狗加歌接口所需 id */
  mixSongId?: string
  /** 网易云原曲 id（翻唱指向原唱） */
  originSongId?: string
  /** Apple Music 资料库条目 id（主 id 为 catalogId 时保留） */
  librarySongId?: string
  aliases?: string[]
}

export interface PlatformSong {
  /** 平台歌曲 ID（本地歌单为歌单内序号，详情查询优先用 sourceSongId） */
  id: string
  /** 原始平台歌曲 ID：本地歌单的 id 是序号时用于详情查询，避免把序号当平台 id */
  sourceSongId?: string
  title: string
  artist: string
  album?: string
  /** 专辑/歌曲封面图 URL */
  coverUrl?: string
  durationMs?: number
  /** 歌曲风格（流派），平台搜索结果提供；缺失时为 undefined */
  genre?: string
  /** 次级唯一标识（本地歌单导出时持久化，供跨平台匹配使用） */
  identifiers?: PlatformSongIdentifiers
}

export interface PlatformPlaylist {
  /** 平台歌单 ID */
  id: string
  name: string
  /** 歌曲数：平台列表接口未提供时缺省（如 Apple Music 资料库歌单无此字段），UI 留空 */
  songCount?: number
  coverUrl?: string
  /** 浏览器打开的歌单分享链接（平台适配器填充） */
  webUrl?: string
  /** 在平台应用中打开歌单的深链（平台适配器填充） */
  appUrl?: string
  /** 歌单创建者/账号标识（上游提供时填充） */
  ownerId?: string
  /** 平台专有定位字段（如酷狗 gcid / global_collection_id / specialid） */
  extraIds?: Record<string, string>
}

export interface PlatformAccount {
  platform: string
  userId: string
  nickname: string
  /** 平台提供的登录账号标识（如 Apple Music 的 Apple ID 邮箱）；没有则展示 userId */
  account?: string
  /** 后台仍在补全账号资料（cookie 已到手，凭证校验/资料抓取未完成） */
  pending?: boolean
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

// --- 平台插件元数据：由各平台模块自带，主进程/渲染层动态消费，不硬编码 ---

/** 平台可声明支持与否的写操作（与 PlatformAdapter 方法一一对应） */
export type PlatformOperation =
  | 'createPlaylist'
  | 'addSongs'
  | 'renamePlaylist'
  | 'deletePlaylist'
  | 'removeSongs'

/** 平台能力声明：决定平台可作为同步来源（read）还是目标（write） */
export interface PlatformCapabilities {
  read: boolean
  write: boolean
  /**
   * 不支持的操作及原因说明（渲染层据此置灰按钮，悬浮显示原因）。
   * 缺省表示 write 能力覆盖的操作全部支持。
   */
  unsupportedOperations?: Partial<Record<PlatformOperation, { reason: string }>>
  /**
   * 是否支持百科查询（歌手歌曲/专辑曲目）。
   * 缺省视为不支持：渲染层歌手/专辑名不可点，避免点击后只有空态。
   */
  encyclopedia?: boolean
}

/** 扫码登录渠道（如 QQ音乐的 qqmusic/wechat/qq）；无渠道的平台省略 */
export interface LoginChannel {
  id: string
  label: string
}

/** 登录方式：扫码（默认）或网页授权（如 Apple Music 无扫码接口） */
export type PlatformLoginType = 'qr' | 'web'

/** 网页登录时从页面顺带抓取的账号资料（抓不到时字段缺省，不影响登录） */
export interface WebLoginProfile {
  /** 页面展示的用户名（如 Apple Music 账号菜单中的昵称） */
  nickname?: string
  /** 账户设置页里的登录账号（如 Apple ID 邮箱） */
  email?: string
}

/** 登录后额外跳转账户设置页抓取登录账号的配置（可选，失败不阻断登录） */
export interface WebLoginAccountProbe {
  /** 账户设置页 URL */
  url: string
  /** 该页面中承载账户资料的 iframe 选择器 */
  frameSelector: string
  /** iframe 内含登录账号文本的元素选择器（从文本中匹配邮箱） */
  emailSelector: string
}

/** 网页登录配置：主进程据此打开登录窗口并从 cookie 提取会话凭证 */
export interface WebLoginConfig {
  /** 登录页 URL（应用内打开，用户在此完成登录） */
  url: string
  /** 登录成功后写入的会话 cookie 名（如 Apple Music 的 media-user-token） */
  cookieName: string
  /** cookie 归属的根 URL（用于查询 cookie） */
  cookieUrl: string
  /** 可选的页面昵称选择器：cookie 到手后等一小会儿读取，读不到照常登录 */
  profileSelector?: string
  /** 可选的账户页探针：再跳一次页面抓登录邮箱，抓不到照常登录 */
  accountProbe?: WebLoginAccountProbe
}

/** 平台元数据：注册时随模块注册，渲染层据此动态渲染 */
export interface PlatformMeta {
  /** 平台唯一 id，与 PlatformAdapter.platform 一致 */
  id: string
  /** 展示名称 */
  name: string
  /** material-symbols 图标名 */
  icon: string
  capabilities: PlatformCapabilities
  /** 扫码登录渠道列表；undefined 表示单一默认渠道 */
  loginChannels?: LoginChannel[]
  /** 登录方式；undefined 视为扫码登录 */
  loginType?: PlatformLoginType
  /** 网页登录配置；loginType 为 web 时必填 */
  webLogin?: WebLoginConfig
}
