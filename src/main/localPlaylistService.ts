import { randomUUID } from 'node:crypto'
import type {
  LocalPlaylistOrigin,
  LocalPlaylistSyncResult,
} from '@core/models/localPlaylist'
import type { PlatformSongIdentifiers } from '@core/models/platform'
import { getDatabase } from './appDatabase'
import type { LocalSongRecordInput } from './localPlaylistStore'

export type LocalSongInput = LocalSongRecordInput

const MAX_NAME_LENGTH = 100
const MAX_SONGS_PER_BATCH = 10000
const IDENTIFIER_KEYS = [
  'albumId',
  'songMid',
  'albumMid',
  'fileId',
  'mixSongId',
  'originSongId',
  'librarySongId',
] as const

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('歌单名不能为空')
  const trimmed = name.trim()
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error('歌单名过长')
  return trimmed
}

function normalizeText(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim().slice(0, max)
}

/** 封面只接受 https URL：打包版 CSP 只放行 https，http/file/data 一律丢弃 */
function normalizeCoverUrl(value: unknown): string | undefined {
  const text = normalizeText(value, 2000)
  if (!text) return undefined
  try {
    return new URL(text).protocol === 'https:' ? text : undefined
  } catch {
    return undefined
  }
}

/** 只透传已知唯一性字段，避免渲染层传入任意 JSON 结构 */
function normalizeIdentifiers(raw: unknown): PlatformSongIdentifiers | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const result: PlatformSongIdentifiers = {}
  for (const key of IDENTIFIER_KEYS) {
    const value = normalizeText(source[key])
    if (value) result[key] = value
  }
  if (Array.isArray(source.aliases)) {
    const aliases = source.aliases
      .map((a) => normalizeText(a, 100))
      .filter((a): a is string => a !== undefined)
      .slice(0, 10)
    if (aliases.length > 0) result.aliases = aliases
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function validateOrigin(raw: unknown): LocalPlaylistOrigin | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('无效的来源歌单信息')
  const source = raw as Record<string, unknown>
  const platform = normalizeText(source.platform, 40)
  const playlistId = normalizeText(source.playlistId, 200)
  if (!platform || !playlistId) throw new Error('无效的来源歌单信息')
  const extraIds: Record<string, string> = {}
  if (source.extraIds && typeof source.extraIds === 'object' && !Array.isArray(source.extraIds)) {
    for (const [key, value] of Object.entries(source.extraIds as Record<string, unknown>)) {
      const text = normalizeText(value)
      if (key.length <= 40 && text) extraIds[key] = text
    }
  }
  return {
    platform,
    playlistId,
    webUrl: normalizeText(source.webUrl, 500),
    appUrl: normalizeText(source.appUrl, 500),
    ownerId: normalizeText(source.ownerId, 200),
    extraIds: Object.keys(extraIds).length > 0 ? extraIds : undefined,
    coverUrl: normalizeCoverUrl(source.coverUrl),
  }
}

function validateSongs(songs: unknown): LocalSongInput[] {
  if (!Array.isArray(songs) || songs.length > MAX_SONGS_PER_BATCH) {
    throw new Error('无效的歌曲列表')
  }
  return songs.map((s) => {
    const raw = s as Record<string, unknown>
    if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('歌曲名不能为空')
    const artist = typeof raw.artist === 'string' ? raw.artist.trim() : ''
    const album = typeof raw.album === 'string' && raw.album.trim() ? raw.album.trim() : undefined
    const durationMs =
      typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
        ? Math.max(0, Math.round(raw.durationMs))
        : undefined
    return {
      title: raw.title.trim(),
      artist,
      album,
      durationMs,
      sourcePlatform: normalizeText(raw.sourcePlatform, 40),
      sourceSongId: normalizeText(raw.sourceSongId, 200),
      identifiers: normalizeIdentifiers(raw.identifiers),
      coverUrl: normalizeCoverUrl(raw.coverUrl),
    }
  })
}

function now(): string {
  return new Date().toISOString()
}

/** 存量导入歌单封面惰性回填：只查本地歌单列表缓存，命中才写，不发网络请求 */
function backfillCoversFromCache(): void {
  const db = getDatabase()
  const missing = db.localPlaylists.list().filter((p) => p.origin && !p.coverUrl)
  if (missing.length === 0) return
  const ts = now()
  for (const playlist of missing) {
    const origin = playlist.origin!
    const cached = db.playlistCache.listPlaylists(origin.platform)?.list
    const coverUrl = normalizeCoverUrl(cached?.find((p) => p.id === origin.playlistId)?.coverUrl)
    if (coverUrl) db.localPlaylists.setCoverIfEmpty(playlist.id, coverUrl, 'platform', ts)
  }
}

export function listLocalPlaylists() {
  backfillCoversFromCache()
  return getDatabase().localPlaylists.list()
}

/** 新建本地歌单并写入歌曲（事务内完成，避免空歌单半成品） */
export function createLocalPlaylist(name: unknown, songs: unknown, origin?: unknown) {
  const trimmed = validateName(name)
  const parsed = validateSongs(songs)
  const parsedOrigin = validateOrigin(origin)
  const store = getDatabase().localPlaylists
  const id = randomUUID()
  const ts = now()
  store.create(id, trimmed, ts, parsedOrigin)
  if (parsedOrigin) store.addOrUpdateSource(id, parsedOrigin, ts)
  if (parsed.length > 0) {
    store.replaceSongs(id, parsed, ts)
  }
  const firstCover = parsed.find((s) => s.coverUrl)?.coverUrl
  if (firstCover) store.setCoverIfEmpty(id, firstCover, 'song', ts)
  return store.get(id)
}

/**
 * 平台歌单 → 本地歌单的幂等增量同步：
 * 同一个来源（平台 + 平台歌单 id）重复同步不会重复建单；按来源歌曲 id 原地更新、新歌追加。
 * 传入 targetId 可把当前平台歌单关联到已有本地歌单（一个本地歌单可有多个来源）。
 */
export function syncPlatformPlaylistToLocal(
  name: unknown,
  songs: unknown,
  origin: unknown,
  targetId: unknown = undefined,
): LocalPlaylistSyncResult {
  const parsedOrigin = validateOrigin(origin)
  if (!parsedOrigin) throw new Error('无效的来源歌单信息')
  const parsedSongs = validateSongs(songs).map((song) => ({
    ...song,
    sourcePlatform: song.sourcePlatform ?? parsedOrigin.platform,
  }))
  const store = getDatabase().localPlaylists
  const ts = now()

  if (targetId !== undefined && targetId !== null) {
    if (typeof targetId !== 'string' || !targetId || !store.get(targetId)) {
      throw new Error('目标本地歌单不存在')
    }
  }
  const existingId = (targetId as string | undefined) ?? store.findBySource(
    parsedOrigin.platform,
    parsedOrigin.playlistId,
  )
  if (existingId) {
    const { added, updated } = store.upsertSongs(existingId, parsedSongs, parsedOrigin.platform, ts)
    store.addOrUpdateSource(existingId, { ...parsedOrigin, lastSyncedAt: ts }, ts)
    const coverUrl = parsedOrigin.coverUrl
    if (coverUrl) store.setCoverIfEmpty(existingId, coverUrl, 'platform', ts)
    const playlist = store.get(existingId)
    if (!playlist) throw new Error('同步后未找到本地歌单')
    return { playlist, created: false, added, updated }
  }

  const created = createLocalPlaylist(name, parsedSongs, parsedOrigin)
  if (!created) throw new Error('创建本地歌单失败')
  return { playlist: created, created: true, added: parsedSongs.length, updated: 0 }
}

export function renameLocalPlaylist(id: unknown, name: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('无效的歌单 ID')
  const trimmed = validateName(name)
  getDatabase().localPlaylists.rename(id, trimmed, now())
}

export function deleteLocalPlaylist(id: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('无效的歌单 ID')
  getDatabase().localPlaylists.remove(id)
}

export function getLocalPlaylistSongs(id: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('无效的歌单 ID')
  const db = getDatabase()
  const store = db.localPlaylists
  const songs = store.songs(id)
  const origin = store.get(id)?.origin
  if (!origin || songs.every((s) => s.coverUrl)) return songs

  // 存量导入歌单在 v8 之前没有歌曲封面列，重启只补了列不会造数据；
  // 从平台歌曲缓存按原顺序（必要时按来源 id）回填，不发网络请求。
  const cached = db.playlistCache.listSongs(origin.platform, origin.playlistId)?.songs
  if (!cached?.length) return songs
  const cachedById = new Map(cached.map((s) => [s.id, s.coverUrl]))
  const updates = songs.flatMap((song, i) => {
    if (song.coverUrl) return []
    const coverUrl = normalizeCoverUrl(
      cached[i]?.coverUrl ?? cachedById.get(song.sourceSongId ?? ''),
    )
    return coverUrl ? [{ position: i, coverUrl }] : []
  })
  if (updates.length === 0) return songs
  store.backfillSongCovers(id, updates)
  return store.songs(id)
}

/** 追加歌曲（去重交给调用方；store 只负责写入） */
export function addLocalPlaylistSongs(id: unknown, songs: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('无效的歌单 ID')
  const parsed = validateSongs(songs)
  const ts = now()
  const store = getDatabase().localPlaylists
  store.addSongs(id, parsed, ts)
  const firstCover = parsed.find((s) => s.coverUrl)?.coverUrl
  if (firstCover) store.setCoverIfEmpty(id, firstCover, 'song', ts)
}

export function removeLocalPlaylistSongs(id: unknown, positions: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('无效的歌单 ID')
  if (
    !Array.isArray(positions) ||
    positions.length === 0 ||
    !positions.every((p) => typeof p === 'number' && Number.isInteger(p) && p >= 0)
  ) {
    throw new Error('无效的歌曲序号列表')
  }
  getDatabase().localPlaylists.removeSongs(id, positions as number[], now())
}
