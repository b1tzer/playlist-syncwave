export interface ExportSong {
  title: string
  artist?: string
  album?: string
  durationMs?: number
}

/** CSV 字段转义：含逗号/引号/换行时用双引号包裹 */
function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** 歌单 → csv（表头 title,artist,album,duration_ms） */
export function toCsv(songs: ExportSong[]): string {
  const rows: string[] = ['title,artist,album,duration_ms']
  for (const s of songs) {
    rows.push(
      [
        escapeField(s.title),
        escapeField(s.artist ?? ''),
        escapeField(s.album ?? ''),
        s.durationMs !== undefined ? String(s.durationMs) : '',
      ].join(','),
    )
  }
  return `${rows.join('\n')}\n`
}
