import type { ParseResult, ParsedSong } from '@core/models/parse'
import { parseLineText } from './lines'
import { splitCsvLine } from './csv'

const TITLE_KEYS = ['title', 'name', 'song', 'songname', 'track', 'trackname']
const ARTIST_KEYS = ['artist', 'singer', 'singername', 'artistname', 'author']

const HEADER_TITLE = /^(title|name|song|track|trackname|歌名|歌曲|曲名)$/
const HEADER_ARTIST = /^(artist|singer|artistname|singername|歌手|演唱|艺人)$/

function pickString(item: object, keys: string[]): string | undefined {
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'string' && v.trim() && keys.includes(k.toLowerCase())) {
      return v.trim()
    }
  }
  return undefined
}

function findFirstArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findFirstArray(v)
      if (found) return found
    }
  }
  return null
}

/** JSON：数组或嵌套对象中第一个数组，键别名映射 title/artist */
export function parseJson(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text.trim())
  } catch {
    return { format: 'json', songs: [], failedLines: [], ignoredLines: [] }
  }

  const items = findFirstArray(data) ?? []
  const songs: ParsedSong[] = []
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    const title = pickString(item, TITLE_KEYS)
    if (!title) return
    const artist = pickString(item, ARTIST_KEYS)
    songs.push({
      title,
      artist,
      raw: JSON.stringify(item),
      lineNumber: i + 1,
      confidence: artist ? 0.9 : 0.6,
    })
  })

  return { format: 'json', songs, failedLines: [], ignoredLines: [] }
}

/** m3u：提取 #EXTINF 逗号后的描述，复用行式管线（顺序自动判定） */
export function parseM3u(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('#EXTINF:'))
    .map((l) => {
      const comma = l.indexOf(',')
      return comma >= 0 ? l.slice(comma + 1).trim() : ''
    })
    .filter((l) => l.length > 0)
  return parseLineText(lines, 'm3u')
}

/** LRC：剥时间戳后复用行式管线，元信息行进 ignoredLines */
export function parseLrc(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\[\d{1,2}:\d{2}(?:\.\d+)?\]/g, '').trim())
    .filter((l) => l.length > 0)
  return parseLineText(lines, 'lrc')
}

/** CSV/表格：表头列映射（title/artist 键别名），无表头按 [歌名, 歌手] */
export function parseCsv(text: string): ParseResult {
  const sep = text.includes('\t') ? '\t' : ','
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  let titleCol = 0
  let artistCol = 1
  let start = 0

  const header = splitCsvLine(rows[0] ?? '', sep)
    .map((c) => c.trim().toLowerCase())
  const hasHeader = header.some((h) => HEADER_TITLE.test(h) || HEADER_ARTIST.test(h))
  if (hasHeader) {
    const t = header.findIndex((h) => HEADER_TITLE.test(h))
    const a = header.findIndex((h) => HEADER_ARTIST.test(h))
    if (t >= 0) titleCol = t
    if (a >= 0) artistCol = a
    start = 1
  }

  const songs: ParsedSong[] = []
  rows.slice(start).forEach((row, i) => {
    const cols = splitCsvLine(row, sep).map((c) => c.trim())
    const title = cols[titleCol]
    if (!title) return
    const artist = cols[artistCol] || undefined
    songs.push({
      title,
      artist,
      raw: row,
      lineNumber: start + i + 1,
      confidence: artist ? 0.9 : 0.6,
    })
  })

  return { format: 'csv', songs, failedLines: [], ignoredLines: [] }
}
