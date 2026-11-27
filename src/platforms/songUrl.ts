import type { EncyclopediaTrack } from '@core/models/encyclopedia'
import type { PlatformSong } from '@core/models/platform'

/**
 * 平台歌曲页 URL 模板（面板曲目跳转与 songDetail 平台跳转共用，模板只此一份）：
 * QQ 用 songMid、网易/酷狗用歌曲 id（酷狗为小写 hash）。
 */
export const songWebUrl: Record<string, (id: string) => string> = {
  qqmusic: (songMid) => `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(songMid)}`,
  netease: (id) => `https://music.163.com/#/song?id=${encodeURIComponent(id)}`,
  kugou: (id) => `https://www.kugou.com/mixsong/${encodeURIComponent(id)}.html`,
}

/** 面板曲目附歌曲页跳转；urlOf 返回 undefined 时不附加（如 QQ 缺 songMid） */
export function attachSongUrl(
  song: PlatformSong,
  urlOf: (song: PlatformSong) => string | undefined,
): EncyclopediaTrack {
  const webUrl = urlOf(song)
  return webUrl ? { ...song, webUrl } : song
}
