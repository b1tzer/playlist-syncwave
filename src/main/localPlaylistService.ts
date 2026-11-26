import { randomUUID } from 'node:crypto'
import type { LocalPlaylistOrigin } from '@core/models/localPlaylist'
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
    }
  })
}

function now(): string {
  return new Date().toISOString()
}

export function listLocalPlaylists() {
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
  if (parsed.length > 0) {
    store.replaceSongs(id, parsed, ts)
  }
  return store.get(id)
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
  return getDatabase().localPlaylists.songs(id)
}

/** 追加歌曲（去重交给调用方；store 只负责写入） */
export function addLocalPlaylistSongs(id: unknown, songs: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('无效的歌单 ID')
  const parsed = validateSongs(songs)
  getDatabase().localPlaylists.addSongs(id, parsed, now())
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
