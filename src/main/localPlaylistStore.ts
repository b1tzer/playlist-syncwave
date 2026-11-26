import { withTransaction, type SqliteDb } from './sqlite'
import type {
  LocalPlaylist,
  LocalPlaylistOrigin,
  LocalPlaylistSong,
} from '@core/models/localPlaylist'
import type { PlatformSongIdentifiers } from '@core/models/platform'

export interface LocalSongRecordInput {
  title: string
  artist: string
  album?: string
  durationMs?: number
  sourcePlatform?: string
  sourceSongId?: string
  identifiers?: PlatformSongIdentifiers
}

interface PlaylistRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  song_count: number
  source_platform: string | null
  source_playlist_id: string | null
  source_web_url: string | null
  source_app_url: string | null
  source_owner_id: string | null
  extra_ids: string | null
}

interface SongRow {
  title: string
  artist: string
  album: string | null
  duration_ms: number | null
  source_platform: string | null
  source_song_id: string | null
  identifiers: string | null
}

function parseJsonObject<T>(raw: string | null): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function createLocalPlaylistStore(db: SqliteDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS local_playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_platform TEXT,
  source_playlist_id TEXT,
  source_web_url TEXT,
  source_app_url TEXT,
  source_owner_id TEXT,
  extra_ids TEXT
)
`)
  db.exec(`
CREATE TABLE IF NOT EXISTS local_playlist_songs (
  playlist_id TEXT NOT NULL REFERENCES local_playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT,
  duration_ms INTEGER,
  source_platform TEXT,
  source_song_id TEXT,
  identifiers TEXT,
  PRIMARY KEY (playlist_id, position)
)
`)
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_local_playlists_source
  ON local_playlists (source_platform, source_playlist_id);
CREATE INDEX IF NOT EXISTS idx_local_playlist_songs_source
  ON local_playlist_songs (playlist_id, source_platform, source_song_id);
`)

  const playlistColumns = `p.id, p.name, p.created_at, p.updated_at,
           p.source_platform, p.source_playlist_id, p.source_web_url,
           p.source_app_url, p.source_owner_id, p.extra_ids,
           COUNT(s.position) AS song_count`

  function toLocalPlaylist(r: PlaylistRow): LocalPlaylist {
    const origin: LocalPlaylistOrigin | undefined = r.source_platform
      ? {
          platform: r.source_platform,
          playlistId: r.source_playlist_id ?? '',
          webUrl: r.source_web_url ?? undefined,
          appUrl: r.source_app_url ?? undefined,
          ownerId: r.source_owner_id ?? undefined,
          extraIds: parseJsonObject<Record<string, string>>(r.extra_ids),
        }
      : undefined
    return {
      id: r.id,
      name: r.name,
      songCount: Number(r.song_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      origin,
    }
  }

  const listStmt = db.prepare(`
    SELECT ${playlistColumns}
    FROM local_playlists p
    LEFT JOIN local_playlist_songs s ON s.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `)

  return {
    list(): LocalPlaylist[] {
      return (listStmt.all() as PlaylistRow[]).map(toLocalPlaylist)
    },

    get(id: string): LocalPlaylist | null {
      const row = db
        .prepare(
          `SELECT ${playlistColumns}
           FROM local_playlists p
           LEFT JOIN local_playlist_songs s ON s.playlist_id = p.id
           WHERE p.id = ?
           GROUP BY p.id`,
        )
        .get(id) as PlaylistRow | undefined
      return row ? toLocalPlaylist(row) : null
    },

    create(id: string, name: string, now: string, origin?: LocalPlaylistOrigin): void {
      db.prepare(
        `INSERT INTO local_playlists
          (id, name, created_at, updated_at, source_platform, source_playlist_id,
           source_web_url, source_app_url, source_owner_id, extra_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        name,
        now,
        now,
        origin?.platform ?? null,
        origin?.playlistId ?? null,
        origin?.webUrl ?? null,
        origin?.appUrl ?? null,
        origin?.ownerId ?? null,
        origin?.extraIds ? JSON.stringify(origin.extraIds) : null,
      )
    },

    rename(id: string, name: string, now: string): void {
      db.prepare('UPDATE local_playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id)
    },

    remove(id: string): void {
      db.prepare('DELETE FROM local_playlist_songs WHERE playlist_id = ?').run(id)
      db.prepare('DELETE FROM local_playlists WHERE id = ?').run(id)
    },

    songs(id: string): LocalPlaylistSong[] {
      const rows = db
        .prepare(
          `SELECT title, artist, album, duration_ms, source_platform, source_song_id, identifiers
           FROM local_playlist_songs
           WHERE playlist_id = ?
           ORDER BY position`,
        )
        .all(id) as SongRow[]
      return rows.map((r, i) => ({
        id: i,
        title: r.title,
        artist: r.artist,
        album: r.album ?? undefined,
        durationMs: r.duration_ms ?? undefined,
        sourcePlatform: r.source_platform ?? undefined,
        sourceSongId: r.source_song_id ?? undefined,
        identifiers: parseJsonObject<PlatformSongIdentifiers>(r.identifiers),
      }))
    },

    /** 整单替换写入（本地编辑以保存时全量覆盖为主） */
    replaceSongs(id: string, songs: LocalSongRecordInput[], now: string): void {
      withTransaction(db, () => {
        db.prepare('DELETE FROM local_playlist_songs WHERE playlist_id = ?').run(id)
        const insert = db.prepare(
          `INSERT INTO local_playlist_songs
            (playlist_id, position, title, artist, album, duration_ms,
             source_platform, source_song_id, identifiers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        songs.forEach((s, i) => {
          insert.run(
            id,
            i,
            s.title,
            s.artist,
            s.album ?? null,
            s.durationMs ?? null,
            s.sourcePlatform ?? null,
            s.sourceSongId ?? null,
            s.identifiers ? JSON.stringify(s.identifiers) : null,
          )
        })
        db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(now, id)
      })
    },

    addSongs(id: string, songs: LocalSongRecordInput[], now: string): void {
      withTransaction(db, () => {
        const row = db
          .prepare('SELECT COUNT(*) AS c FROM local_playlist_songs WHERE playlist_id = ?')
          .get(id) as { c: number }
        const insert = db.prepare(
          `INSERT INTO local_playlist_songs
            (playlist_id, position, title, artist, album, duration_ms,
             source_platform, source_song_id, identifiers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        songs.forEach((s, i) => {
          insert.run(
            id,
            Number(row.c) + i,
            s.title,
            s.artist,
            s.album ?? null,
            s.durationMs ?? null,
            s.sourcePlatform ?? null,
            s.sourceSongId ?? null,
            s.identifiers ? JSON.stringify(s.identifiers) : null,
          )
        })
        db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(now, id)
      })
    },

    removeSongs(id: string, positions: number[], now: string): void {
      if (positions.length === 0) return
      withTransaction(db, () => {
        const placeholders = positions.map(() => '?').join(',')
        db.prepare(
          `DELETE FROM local_playlist_songs WHERE playlist_id = ? AND position IN (${placeholders})`,
        ).run(id, ...positions)
        // 删除后重排 position 保持连续
        const remaining = db
          .prepare('SELECT position FROM local_playlist_songs WHERE playlist_id = ? ORDER BY position')
          .all(id) as Array<{ position: number }>
        const update = db.prepare(
          'UPDATE local_playlist_songs SET position = ? WHERE playlist_id = ? AND position = ?',
        )
        remaining.forEach((r, i) => {
          if (r.position !== i) update.run(i, id, r.position)
        })
        db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(now, id)
      })
    },
  }
}

export type LocalPlaylistStore = ReturnType<typeof createLocalPlaylistStore>
