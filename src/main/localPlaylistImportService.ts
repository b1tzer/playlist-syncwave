import type { LocalPlaylistSyncResult } from '@core/models/localPlaylist'
import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'
import { asObject, pickString } from '../platforms/json'
import { getPlatform, resolveAdapter } from './platformRegistry'
import { syncPlatformPlaylistToLocal } from './localPlaylistService'

const FETCH_TIMEOUT_MS = 30_000
const MAX_EXPORT_SONGS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('请求超时，请稍后重试')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 把平台歌单完整导出为本地歌单：保留来源定位字段与每首歌的平台 id / 次级唯一标识，
 * 供后续跨平台匹配直接复用，而不是只留下「歌名 + 歌手」文本。
 */
export async function importPlatformPlaylistToLocal(
  platformValue: unknown,
  playlistValue: unknown,
  targetIdValue?: unknown,
): Promise<LocalPlaylistSyncResult> {
  const platform = pickString(platformValue)
  if (!platform) throw new Error('无效的平台')
  const raw = asObject(playlistValue)
  const playlistId = pickString(raw.id)
  if (!playlistId) throw new Error('无效的歌单 ID')
  const name = pickString(raw.name) ?? '未命名歌单'
  if (name.length > 100) throw new Error('歌单名过长')

  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) throw new Error('尚未登录')
  const adapter = await resolveAdapter(platform)
  const songs = await withTimeout(
    adapter.getPlaylistSongs(credential, playlistId),
    FETCH_TIMEOUT_MS,
  )
  if (songs.length === 0) throw new Error('所选歌单没有歌曲可导出')
  if (songs.length > MAX_EXPORT_SONGS) throw new Error('歌单歌曲过多，暂不支持导出')

  const playlist = playlistValue as PlatformPlaylist
  const localSongs = songs.map((song: PlatformSong) => ({
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationMs: song.durationMs,
    sourcePlatform: platform,
    sourceSongId: song.id,
    identifiers: song.identifiers,
    coverUrl: song.coverUrl,
  }))
  return syncPlatformPlaylistToLocal(
    name,
    localSongs,
    {
      platform,
      playlistId,
      webUrl: playlist.webUrl,
      appUrl: playlist.appUrl,
      ownerId: playlist.ownerId,
      extraIds: playlist.extraIds,
      coverUrl: playlist.coverUrl,
    },
    targetIdValue,
  )
}
