import type { DetectedFormat } from '@core/models/parse'
export type { DetectedFormat }

export type LineCategory = 'song' | 'meta' | 'template' | 'chat' | 'link' | 'noise'

export interface ClassifiedLine {
  category: LineCategory
  /** 清理后的文本（chat 剥前缀、其余 trim） */
  cleaned: string
  /** template 行中提取的《歌名》 */
  quotedTitle?: string
}

const META_PREFIX = /^(作词|作曲|编曲|填词|谱曲|专辑|发行|制作|混音|母带|演唱|和声|吉他|钢琴|时长|时间)[:：]/
const TEMPLATE =
  /^(分享.{0,30}(歌单|歌曲|音乐)|来自.{0,12}(音乐|音乐平台)|复制这条信息|打开.{0,12}(App|APP|app))/
const CHAT_PREFIX = /^[\p{L}\p{N}_\-\u4e00-\u9fff]{1,20}[:：]\s*/u
const BRACKET_CHAT = /^【[^】]{1,20}】\s*/
const URL_PATTERN = /https?:\/\/|music\.163\.com|y\.qq\.com|kugou\.com|kuwo\.cn|migu\.cn/
const QUOTED_TITLE = /《([^》]{1,60})》/
const TIMESTAMP_LINE = /^\[?\d{1,2}:\d{2}(?:\.\d+)?\]?/

function hasLetterOrNumber(line: string): boolean {
  return /[\p{L}\p{N}]/u.test(line)
}

/**
 * 输入格式自动探测：按特征打分识别，用户无需手动指定。
 * 优先级：json > m3u > lrc > csv > share > lines。
 */
export function detectFormat(text: string): DetectedFormat {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'lines'

  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // 非 JSON，继续探测
    }
  }

  const lines = trimmed.split(/\r?\n/)
  if (/^#EXTM3U/m.test(trimmed) || lines.some((l) => l.startsWith('#EXTINF'))) {
    return 'm3u'
  }

  const contentLines = lines.filter((l) => l.trim().length > 0)
  const timestampRatio =
    contentLines.filter((l) => TIMESTAMP_LINE.test(l.trim())).length / contentLines.length
  if (timestampRatio >= 0.6) return 'lrc'

  const rows = contentLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  for (const sep of ['\t', ',']) {
    const colCounts = rows.map((r) => r.split(sep).length)
    if (colCounts.every((n) => n >= 2)) {
      const mode = colCounts[0]
      const consistent = colCounts.filter((n) => n === mode).length / colCounts.length
      if (consistent >= 0.8 && !rows.some((r) => / - /.test(r))) return 'csv'
    }
  }

  if (
    URL_PATTERN.test(trimmed) ||
    /分享.{0,30}(歌单|歌曲|音乐)/.test(trimmed) ||
    /来自.{0,12}(音乐|音乐平台)/.test(trimmed)
  ) {
    return 'share'
  }

  return 'lines'
}

/**
 * 行分类：song / meta / template / chat / link / noise。
 * chat 前缀剥除后递归分类（限制深度），避免嵌套说话人漏判。
 */
export function classifyLine(raw: string): ClassifiedLine {
  let line = raw.trim()
  if (line.length === 0 || !hasLetterOrNumber(line)) {
    return { category: 'noise', cleaned: '' }
  }

  // 先查原始行，避免「分享歌单：xxx」被误当说话人前缀
  if (META_PREFIX.test(line)) return { category: 'meta', cleaned: line }
  if (TEMPLATE.test(line)) {
    const quotedTitle = line.match(QUOTED_TITLE)?.[1]
    return { category: 'template', cleaned: line, quotedTitle }
  }
  if (URL_PATTERN.test(line)) return { category: 'link', cleaned: line }

  let depth = 0
  let isChat = false
  while (depth < 5 && BRACKET_CHAT.test(line)) {
    line = line.replace(BRACKET_CHAT, '')
    depth++
    isChat = true
  }
  while (depth < 5) {
    if (META_PREFIX.test(line) || TEMPLATE.test(line)) break
    if (!CHAT_PREFIX.test(line)) break
    line = line.replace(CHAT_PREFIX, '')
    depth++
    isChat = true
  }

  if (line.length === 0 || !hasLetterOrNumber(line)) {
    return { category: 'noise', cleaned: '' }
  }
  if (META_PREFIX.test(line)) return { category: 'meta', cleaned: line }
  if (TEMPLATE.test(line)) {
    const quotedTitle = line.match(QUOTED_TITLE)?.[1]
    return { category: 'template', cleaned: line, quotedTitle }
  }
  if (URL_PATTERN.test(line)) return { category: 'link', cleaned: line }

  return isChat
    ? { category: 'chat', cleaned: line }
    : { category: 'song', cleaned: line }
}
