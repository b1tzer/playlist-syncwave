export interface ExportSong {
  title: string
  artist?: string
  durationMs?: number
}

/** 歌单 → m3u（#EXTM3U + #EXTINF 时长与「歌手 - 歌名」） */
export function toM3u(songs: ExportSong[]): string {
  const lines: string[] = ['#EXTM3U']
  for (const s of songs) {
    const seconds = s.durationMs !== undefined ? Math.round(s.durationMs / 1000) : -1
    const label = s.artist ? `${s.artist} - ${s.title}` : s.title
    lines.push(`#EXTINF:${seconds},${label}`)
    lines.push(label)
  }
  return `${lines.join('\n')}\n`
}
