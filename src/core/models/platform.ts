export interface PlatformSong {
  /** 平台歌曲 ID */
  id: string
  title: string
  artist: string
  album?: string
  /** 专辑/歌曲封面图 URL */
  coverUrl?: string
  durationMs?: number
  /** 歌曲风格（流派），平台搜索结果提供；缺失时为 undefined */
  genre?: string
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
}

/** 扫码登录渠道（如 QQ音乐的 qqmusic/wechat/qq）；无渠道的平台省略 */
export interface LoginChannel {
  id: string
  label: string
}

/** 登录方式：扫码（默认）或网页授权（如 Apple Music 无扫码接口） */
export type PlatformLoginType = 'qr' | 'web'

/** 网页登录配置：主进程据此打开登录窗口并从 cookie 提取会话凭证 */
export interface WebLoginConfig {
  /** 登录页 URL（应用内打开，用户在此完成登录） */
  url: string
  /** 登录成功后写入的会话 cookie 名（如 Apple Music 的 media-user-token） */
  cookieName: string
  /** cookie 归属的根 URL（用于查询 cookie） */
  cookieUrl: string
}

/** 平台元数据：注册时随模块注册，渲染层据此动态渲染 */
export interface PlatformMeta {
  /** 平台唯一 id，与 PlatformAdapter.platform 一致 */
  id: string
  /** 展示名称 */
  name: string
  /** 登录接口说明文案 */
  apiLabel: string
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
