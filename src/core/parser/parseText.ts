import type { ParseOptions, ParseResult } from '@core/models/parse'
import { createLogger } from '@core/logging'
import { detectFormat } from './detect'
import { parseLineText } from './lines'
import { parseCsv, parseJson, parseLrc, parseM3u } from './structured'

const log = createLogger({ module: 'parser' })

/**
 * 文本快速创建全自动解析入口：
 * 格式探测（json/m3u/lrc/csv/share/lines）→ 分派到对应解析器。
 * 用户无需手动指定格式；`options.order` 仅作高级覆盖。
 */
export function parseText(text: string, options: ParseOptions = {}): ParseResult {
  const format = detectFormat(text)
  log.debug('parse.detected', '输入格式探测结果', { format, lines: text.split(/\r?\n/).length })

  let result: ParseResult
  if (format === 'json') result = parseJson(text)
  else if (format === 'csv') result = parseCsv(text)
  else if (format === 'm3u') result = parseM3u(text)
  else if (format === 'lrc') result = parseLrc(text)
  // share / lines：同一行式管线，分享模板行由行分类过滤
  else result = parseLineText(text.split(/\r?\n/), format, options.order)

  log.info('parse.complete', '解析完成', {
    format: result.format,
    songs: result.songs.length,
    failedLines: result.failedLines.length,
    ignoredLines: result.ignoredLines.length,
    detectedOrder: result.detectedOrder,
  })

  return result
}
