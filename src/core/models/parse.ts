export type FieldOrder = 'title-first' | 'artist-first'

export interface ParseOptions {
  /** 分隔符两侧的字段顺序，默认 title-first（歌名 - 歌手） */
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
  /** 解析置信度 0~1：有双字段为 0.9，纯歌名为 0.6 */
  confidence: number
}

export interface FailedLine {
  raw: string
  lineNumber: number
  reason: 'missing-title' | 'missing-artist'
}

export interface ParseResult {
  songs: ParsedSong[]
  failedLines: FailedLine[]
}
