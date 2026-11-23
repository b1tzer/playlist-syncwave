import type { FailedLine, ParseOptions, ParseResult, ParsedSong } from '@core/models/parse'

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

export function parseText(text: string, options: ParseOptions = {}): ParseResult {
  const order = options.order ?? 'title-first'
  const songs: ParsedSong[] = []
  const failedLines: FailedLine[] = []

  text.split(/\r?\n/).forEach((original, index) => {
    const raw = original.trim()
    const cleaned = cleanLine(raw)
    if (isNoise(cleaned)) return

    const lineNumber = index + 1

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
      songs.push({
        title: cleaned,
        raw,
        lineNumber,
        confidence: 0.6,
      })
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

    const titleFirst = order === 'title-first'
    songs.push({
      title: (titleFirst ? first : second)!,
      artist: (titleFirst ? second : first)!,
      raw,
      lineNumber,
      confidence: 0.9,
    })
  })

  return { songs, failedLines }
}
