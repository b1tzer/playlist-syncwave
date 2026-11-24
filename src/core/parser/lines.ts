import type {
  FailedLine,
  IgnoredLineCategory,
  ParseResult,
  ParsedSong,
} from '@core/models/parse'
import { classifyLine } from './detect'
import { defaultOrderForPair, inferPair, majorityOrder, splitQuotedTitle } from './orderInfer'

const SEPARATOR = /\s*(?:——|\s--\s|\s-\s|\s\|\s)\s*|\t+|—/
const TIMESTAMP = /^\[?\d{1,2}:\d{2}(?:\.\d+)?\]?\s*/
const ORDER_PREFIX = /^(?:[（(]?\d{1,3}[）).、])\s*/
const EMOJI = /\p{Extended_Pictographic}\s*/gu
const DANGLING_SEPARATOR = /(?:^\s*-\s*$|\s-\s*$|^\s*-\s)/

function isNoise(line: string): boolean {
  if (line.length === 0) return true
  return !/[\p{L}\p{N}]/u.test(line)
}

function cleanLine(raw: string): string {
  return raw
    .replace(ORDER_PREFIX, '')
    .replace(TIMESTAMP, '')
    .replace(EMOJI, '')
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
}

const IGNORED_CATEGORY: Record<string, IgnoredLineCategory> = {
  meta: 'meta',
  template: 'template',
  link: 'link',
}

/**
 * 行式文本解析：行分类去噪 → 书名号锚定/分隔符拆分 → 字段顺序自动判定 + 整段投票。
 * `format` 由调用方指定（lines/share/m3u/lrc 提取后共用此管线）。
 */
export function parseLineText(
  lines: string[],
  format: ParseResult['format'],
  override?: 'title-first' | 'artist-first',
): ParseResult {
  const songs: ParsedSong[] = []
  const failedLines: FailedLine[] = []
  const ignoredLines: ParseResult['ignoredLines'] = []
  let detectedOrder: 'title-first' | 'artist-first' | undefined

  interface RawPair {
    first: string
    second: string
    raw: string
    lineNumber: number
  }

  const rawPairs: RawPair[] = []
  const singles: Array<{ cleaned: string; raw: string; lineNumber: number }> = []

  lines.forEach((original, index) => {
    const raw = original.trim()
    const lineNumber = index + 1
    const classified = classifyLine(raw)

    if (classified.category === 'noise') return
    if (classified.category === 'meta') {
      ignoredLines.push({ raw, lineNumber, category: IGNORED_CATEGORY[classified.category] })
      return
    }
    if (classified.category === 'link') {
      ignoredLines.push({ raw, lineNumber, category: 'link' })
      return
    }
    if (classified.category === 'template') {
      if (classified.quotedTitle) {
        songs.push({ title: classified.quotedTitle, raw, lineNumber, confidence: 0.55 })
      } else {
        ignoredLines.push({ raw, lineNumber, category: 'template' })
      }
      return
    }

    // song / chat（已剥说话人前缀）
    const cleaned = cleanLine(classified.cleaned)
    if (isNoise(cleaned)) return

    const quoted = splitQuotedTitle(cleaned)
    if (quoted) {
      songs.push({
        title: quoted.title,
        artist: quoted.artist,
        raw,
        lineNumber,
        confidence: quoted.artist ? 0.85 : 0.7,
        orderConfidence: 0.9,
      })
      return
    }

    if (DANGLING_SEPARATOR.test(cleaned)) {
      failedLines.push({
        raw,
        lineNumber,
        reason: cleaned.trimStart().startsWith('-') ? 'missing-title' : 'missing-artist',
      })
      return
    }

    const parts = cleaned.split(SEPARATOR)
    if (parts.length === 1) {
      singles.push({ cleaned, raw, lineNumber })
      return
    }

    const [first, second] = parts.map((p) => p.trim())
    if (!first || !second) {
      failedLines.push({
        raw,
        lineNumber,
        reason: !first ? 'missing-title' : 'missing-artist',
      })
      return
    }

    rawPairs.push({ first, second, raw, lineNumber })
  })

  // 字段顺序：手动覆盖 > 逐行信号判定 > 整段投票裁决歧义
  if (override) {
    detectedOrder = override
    for (const pair of rawPairs) {
      const titleFirst = override === 'title-first'
      songs.push({
        title: (titleFirst ? pair.first : pair.second)!,
        artist: (titleFirst ? pair.second : pair.first)!,
        raw: pair.raw,
        lineNumber: pair.lineNumber,
        confidence: 0.9,
        orderConfidence: 1,
      })
    }
  } else {
    const inferences = rawPairs.map((p) => inferPair(p.first, p.second))
    const voted = majorityOrder(inferences.map((i) => i.order))
    if (voted) detectedOrder = voted

    rawPairs.forEach((pair, i) => {
      const inference = inferences[i]
      const finalOrder = inference.order === 'ambiguous' ? voted : inference.order

      if (!finalOrder) {
        const defaultOrder = defaultOrderForPair(pair.first, pair.second)
        const titleFirst = defaultOrder === 'title-first'
        songs.push({
          title: (titleFirst ? pair.first : pair.second)!,
          artist: titleFirst ? pair.second : pair.first,
          raw: pair.raw,
          lineNumber: pair.lineNumber,
          confidence: 0.45,
          orderConfidence: 0.5,
          candidates: titleFirst
            ? [
                { title: pair.first, artist: pair.second },
                { title: pair.second, artist: pair.first },
              ]
            : [
                { title: pair.second, artist: pair.first },
                { title: pair.first, artist: pair.second },
              ],
        })
        return
      }

      const titleFirst = finalOrder === 'title-first'
      songs.push({
        title: (titleFirst ? pair.first : pair.second)!,
        artist: (titleFirst ? pair.second : pair.first)!,
        raw: pair.raw,
        lineNumber: pair.lineNumber,
        confidence: inference.order === 'ambiguous' ? 0.7 : inference.confidence,
        orderConfidence: inference.order === 'ambiguous' ? 0.55 : inference.confidence,
      })
    })
  }

  for (const single of singles) {
    songs.push({
      title: single.cleaned,
      raw: single.raw,
      lineNumber: single.lineNumber,
      confidence: 0.6,
    })
  }

  return { format, detectedOrder, songs, failedLines, ignoredLines }
}
