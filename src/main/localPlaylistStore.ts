import { withTransaction, type SqliteDb } from './sqlite'
import type { LocalPlaylist, LocalPlaylistSong } from '@core/models/localPlaylist'

interface PlaylistRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  song_count: number
}

interface SongRow {
  title: string
  artist: string
  album: string | null
  duration_ms: number | null
}

export function createLocalPlaylistStore(db: SqliteDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS local_playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  PRIMARY KEY (playlist_id, position)
)
`)

  const listStmt = db.prepare(`
    SELECT p.id, p.name, p.created_at, p.updated_at,
           COUNT(s.position) AS song_count
    FROM local_playlists p
    LEFT JOIN local_playlist_songs s ON s.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `)

  return {
    list(): LocalPlaylist[] {
      const rows = listStmt.all() as PlaylistRow[]
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        songCount: Number(r.song_count),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    },

    get(id: string): LocalPlaylist | null {
      const row = db
        .prepare(
          `SELECT p.id, p.name, p.created_at, p.updated_at,
                  COUNT(s.position) AS song_count
           FROM local_playlists p
           LEFT JOIN local_playlist_songs s ON s.playlist_id = p.id
           WHERE p.id = ?
           GROUP BY p.id`,
        )
        .get(id) as PlaylistRow | undefined
      if (!row) return null
      return {
        id: row.id,
        name: row.name,
        songCount: Number(row.song_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },

    create(id: string, name: string, now: string): void {
      db.prepare('INSERT INTO local_playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        id,
        name,
        now,
        now,
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
          `SELECT title, artist, album, duration_ms
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
      }))
    },

    /** 整单替换写入（本地编辑以保存时全量覆盖为主） */
    replaceSongs(
      id: string,
      songs: Array<{ title: string; artist: string; album?: string; durationMs?: number }>,
      now: string,
    ): void {
      withTransaction(db, () => {
        db.prepare('DELETE FROM local_playlist_songs WHERE playlist_id = ?').run(id)
        const insert = db.prepare(
          `INSERT INTO local_playlist_songs (playlist_id, position, title, artist, album, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        songs.forEach((s, i) => {
          insert.run(id, i, s.title, s.artist, s.album ?? null, s.durationMs ?? null)
        })
        db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(now, id)
      })
    },

    addSongs(
      id: string,
      songs: Array<{ title: string; artist: string; album?: string; durationMs?: number }>,
      now: string,
    ): void {
      withTransaction(db, () => {
        const row = db
          .prepare('SELECT COUNT(*) AS c FROM local_playlist_songs WHERE playlist_id = ?')
          .get(id) as { c: number }
        const insert = db.prepare(
          `INSERT INTO local_playlist_songs (playlist_id, position, title, artist, album, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        songs.forEach((s, i) => {
          insert.run(id, Number(row.c) + i, s.title, s.artist, s.album ?? null, s.durationMs ?? null)
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
