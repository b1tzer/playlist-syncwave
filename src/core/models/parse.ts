export type FieldOrder = 'title-first' | 'artist-first'

/** 输入格式（自动探测结果） */
export type DetectedFormat = 'lines' | 'json' | 'csv' | 'm3u' | 'lrc' | 'share'

/** 被忽略行的类别 */
export type IgnoredLineCategory = 'meta' | 'template' | 'noise' | 'link'

export interface ParseOptions {
  /**
   * 高级覆盖项：手动指定分隔符两侧字段顺序。
   * 缺省时全自动判定（信号评分 + 整段投票）。
   */
  order?: FieldOrder
}

export interface ParsedSong {
  /** 清理噪声后的歌名 */
  title: string
  /** 歌手；纯歌名列表时为 undefined */
  artist?: string
  /** trim 后的原始行文本，供用户对照修正 */
  raw: string
  /** 1-based 行号 */
  lineNumber: number
  /** 解析置信度 0~1 */
  confidence: number
  /** 字段顺序自动判定的置信度（双字段行） */
  orderConfidence?: number
  /** 顺序歧义时的双候选，供预览一键切换 */
  candidates?: Array<{ title: string; artist?: string }>
}

export interface FailedLine {
  raw: string
  lineNumber: number
  reason: 'missing-title' | 'missing-artist' | 'ambiguous-order' | 'unrecognized'
}

export interface IgnoredLine {
  raw: string
  lineNumber: number
  category: IgnoredLineCategory
}

export interface ParseResult {
  /** 自动探测出的输入格式 */
  format: DetectedFormat
  /** 自动判定的字段顺序（双字段行多数一致时） */
  detectedOrder?: FieldOrder
  songs: ParsedSong[]
  failedLines: FailedLine[]
  /** 被过滤的非歌曲行（模板/元信息/链接） */
  ignoredLines: IgnoredLine[]
}
