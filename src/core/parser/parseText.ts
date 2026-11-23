import type { ParseOptions, ParseResult } from '@core/models/parse'
import { detectFormat } from './detect'
import { parseLineText } from './lines'
import { parseCsv, parseJson, parseLrc, parseM3u } from './structured'

/**
 * 文本快速创建全自动解析入口：
 * 格式探测（json/m3u/lrc/csv/share/lines）→ 分派到对应解析器。
 * 用户无需手动指定格式；`options.order` 仅作高级覆盖。
 */
export function parseText(text: string, options: ParseOptions = {}): ParseResult {
  const format = detectFormat(text)

  if (format === 'json') return parseJson(text)
  if (format === 'csv') return parseCsv(text)
  if (format === 'm3u') return parseM3u(text)
  if (format === 'lrc') return parseLrc(text)

  // share / lines：同一行式管线，分享模板行由行分类过滤
  return parseLineText(text.split(/\r?\n/), format, options.order)
}
