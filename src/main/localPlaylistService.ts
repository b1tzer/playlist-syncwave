import { randomUUID } from 'node:crypto'
import { getDatabase } from './appDatabase'

export interface LocalSongInput {
  title: string
  artist: string
  album?: string
  durationMs?: number
}

const MAX_NAME_LENGTH = 100
const MAX_SONGS_PER_BATCH = 5000

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('歌单名不能为空')
  const trimmed = name.trim()
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error('歌单名过长')
  return trimmed
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
    return { title: raw.title.trim(), artist, album, durationMs }
  })
}

function now(): string {
  return new Date().toISOString()
}

export function listLocalPlaylists() {
  return getDatabase().localPlaylists.list()
}

/** 新建本地歌单并写入歌曲（事务内完成，避免空歌单半成品） */
export function createLocalPlaylist(name: unknown, songs: unknown) {
  const trimmed = validateName(name)
  const parsed = validateSongs(songs)
  const store = getDatabase().localPlaylists
  const id = randomUUID()
  const ts = now()
  store.create(id, trimmed, ts)
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
