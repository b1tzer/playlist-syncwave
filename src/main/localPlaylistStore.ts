import { withTransaction, type SqliteDb } from './sqlite'
import type {
  LocalPlaylist,
  LocalPlaylistOrigin,
  LocalPlaylistSong,
  LocalPlaylistSource,
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
  coverUrl?: string
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
  cover_url: string | null
  cover_source: string | null
}

interface SongRow {
  title: string
  artist: string
  album: string | null
  duration_ms: number | null
  source_platform: string | null
  source_song_id: string | null
  identifiers: string | null
  cover_url: string | null
}

interface SourceRow {
  playlist_id: string
  platform: string
  source_playlist_id: string
  web_url: string | null
  app_url: string | null
  owner_id: string | null
  extra_ids: string | null
  cover_url: string | null
  last_synced_at: string | null
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
  extra_ids TEXT,
  cover_url TEXT,
  cover_source TEXT
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
  cover_url TEXT,
  PRIMARY KEY (playlist_id, position)
)
`)
  db.exec(`
CREATE TABLE IF NOT EXISTS local_playlist_sources (
  playlist_id TEXT NOT NULL REFERENCES local_playlists(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  source_playlist_id TEXT NOT NULL,
  web_url TEXT,
  app_url TEXT,
  owner_id TEXT,
  extra_ids TEXT,
  cover_url TEXT,
  last_synced_at TEXT,
  PRIMARY KEY (playlist_id, platform, source_playlist_id)
)
`)
  db.exec(`
CREATE INDEX IF NOT EXISTS idx_local_playlists_source
  ON local_playlists (source_platform, source_playlist_id);
CREATE INDEX IF NOT EXISTS idx_local_playlist_songs_source
  ON local_playlist_songs (playlist_id, source_platform, source_song_id);
CREATE INDEX IF NOT EXISTS idx_local_playlist_sources_local
  ON local_playlist_sources (playlist_id, platform, source_playlist_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_playlist_sources_unique_source
  ON local_playlist_sources (platform, source_playlist_id);
`)

  const playlistColumns = `p.id, p.name, p.created_at, p.updated_at,
           p.source_platform, p.source_playlist_id, p.source_web_url,
           p.source_app_url, p.source_owner_id, p.extra_ids,
           p.cover_url, p.cover_source,
           COUNT(s.position) AS song_count`

  function toSource(r: SourceRow): LocalPlaylistSource {
    return {
      platform: r.platform,
      playlistId: r.source_playlist_id,
      webUrl: r.web_url ?? undefined,
      appUrl: r.app_url ?? undefined,
      ownerId: r.owner_id ?? undefined,
      extraIds: parseJsonObject<Record<string, string>>(r.extra_ids),
      coverUrl: r.cover_url ?? undefined,
      lastSyncedAt: r.last_synced_at ?? undefined,
    }
  }

  function readSources(id: string): LocalPlaylistSource[] {
    return (
      db
        .prepare('SELECT * FROM local_playlist_sources WHERE playlist_id = ? ORDER BY last_synced_at')
        .all(id) as SourceRow[]
    ).map(toSource)
  }

  function toLocalPlaylist(r: PlaylistRow, sources: LocalPlaylistSource[] = []): LocalPlaylist {
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
      coverUrl: r.cover_url ?? undefined,
      coverSource: r.cover_source === 'platform' || r.cover_source === 'song' ? r.cover_source : undefined,
      sources,
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
      const rows = listStmt.all() as PlaylistRow[]
      const sourceRows = db
        .prepare('SELECT * FROM local_playlist_sources ORDER BY last_synced_at')
        .all() as SourceRow[]
      const grouped = new Map<string, LocalPlaylistSource[]>()
      for (const row of sourceRows) {
        const list = grouped.get(row.playlist_id) ?? []
        list.push(toSource(row))
        grouped.set(row.playlist_id, list)
      }
      return rows.map((r) => toLocalPlaylist(r, grouped.get(r.id) ?? []))
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
      return row ? toLocalPlaylist(row, readSources(id)) : null
    },

    create(id: string, name: string, now: string, origin?: LocalPlaylistOrigin): void {
      db.prepare(
        `INSERT INTO local_playlists
          (id, name, created_at, updated_at, source_platform, source_playlist_id,
           source_web_url, source_app_url, source_owner_id, extra_ids, cover_url, cover_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        origin?.coverUrl ?? null,
        origin?.coverUrl ? 'platform' : null,
      )
    },

    rename(id: string, name: string, now: string): void {
      db.prepare('UPDATE local_playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id)
    },

    /** 仅在封面为空时写入派生封面，避免覆盖平台导入的封面 */
    setCoverIfEmpty(
      id: string,
      coverUrl: string,
      source: 'platform' | 'song',
      now: string,
    ): void {
      db.prepare(
        `UPDATE local_playlists
         SET cover_url = ?, cover_source = ?, updated_at = ?
         WHERE id = ? AND (cover_url IS NULL OR cover_url = '')`,
      ).run(coverUrl, source, now, id)
    },

    /** 查找某个平台歌单已对应的本地歌单（优先多来源表，兼容旧库的单来源列） */
    findBySource(platform: string, sourcePlaylistId: string): string | null {
      const source = db
        .prepare(
          `SELECT playlist_id FROM local_playlist_sources
           WHERE platform = ? AND source_playlist_id = ? LIMIT 1`,
        )
        .get(platform, sourcePlaylistId) as { playlist_id: string } | undefined
      if (source) return source.playlist_id
      const legacy = db
        .prepare(
          `SELECT id FROM local_playlists
           WHERE source_platform = ? AND source_playlist_id = ? LIMIT 1`,
        )
        .get(platform, sourcePlaylistId) as { id: string } | undefined
      return legacy?.id ?? null
    },

    /** 登记/更新来源关系：一个平台歌单只归属一个本地歌单，重复登记视为改派 */
    addOrUpdateSource(playlistId: string, source: LocalPlaylistSource, now: string): void {
      withTransaction(db, () => {
        db.prepare(
          `DELETE FROM local_playlist_sources
           WHERE platform = ? AND source_playlist_id = ? AND playlist_id <> ?`,
        ).run(source.platform, source.playlistId, playlistId)
        db.prepare(
          `UPDATE local_playlists
           SET source_platform = NULL, source_playlist_id = NULL, source_web_url = NULL,
               source_app_url = NULL, source_owner_id = NULL, extra_ids = NULL
           WHERE source_platform = ? AND source_playlist_id = ? AND id <> ?`,
        ).run(source.platform, source.playlistId, playlistId)
        db.prepare(
          `INSERT INTO local_playlist_sources
            (playlist_id, platform, source_playlist_id, web_url, app_url,
             owner_id, extra_ids, cover_url, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, source_playlist_id) DO UPDATE SET
             playlist_id = excluded.playlist_id,
             web_url = excluded.web_url,
             app_url = excluded.app_url,
             owner_id = excluded.owner_id,
             extra_ids = excluded.extra_ids,
             cover_url = excluded.cover_url,
             last_synced_at = excluded.last_synced_at`,
        ).run(
          playlistId,
          source.platform,
          source.playlistId,
          source.webUrl ?? null,
          source.appUrl ?? null,
          source.ownerId ?? null,
          source.extraIds ? JSON.stringify(source.extraIds) : null,
          source.coverUrl ?? null,
          source.lastSyncedAt ?? now,
        )
        db.prepare(
          `UPDATE local_playlists
           SET source_platform = ?, source_playlist_id = ?, source_web_url = ?,
               source_app_url = ?, source_owner_id = ?, extra_ids = ?,
               cover_url = COALESCE(cover_url, ?),
               cover_source = COALESCE(cover_source, 'platform')
           WHERE id = ?`,
        ).run(
          source.platform,
          source.playlistId,
          source.webUrl ?? null,
          source.appUrl ?? null,
          source.ownerId ?? null,
          source.extraIds ? JSON.stringify(source.extraIds) : null,
          source.coverUrl ?? null,
          playlistId,
        )
      })
    },

    listSources(id: string): LocalPlaylistSource[] {
      return readSources(id)
    },

    /** 按来源平台歌曲 id 增量写入：已存在的原地更新，新歌追加，不删除上游已移除的歌 */
    upsertSongs(
      id: string,
      incoming: LocalSongRecordInput[],
      platform: string,
      now: string,
    ): { added: number; updated: number } {
      let added = 0
      let updated = 0
      withTransaction(db, () => {
        const existing = db
          .prepare(
            `SELECT position, source_song_id FROM local_playlist_songs
             WHERE playlist_id = ? AND source_platform = ? ORDER BY position`,
          )
          .all(id, platform) as Array<{ position: number; source_song_id: string | null }>
        const positions = new Map<string, number>()
        for (const row of existing) {
          if (row.source_song_id) positions.set(row.source_song_id, row.position)
        }
        const update = db.prepare(
          `UPDATE local_playlist_songs
           SET title = ?, artist = ?, album = ?, duration_ms = ?,
               identifiers = ?, cover_url = ?
           WHERE playlist_id = ? AND position = ?`,
        )
        const insert = db.prepare(
          `INSERT INTO local_playlist_songs
            (playlist_id, position, title, artist, album, duration_ms,
             source_platform, source_song_id, identifiers, cover_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        let nextPosition = (db
          .prepare('SELECT COUNT(*) AS c FROM local_playlist_songs WHERE playlist_id = ?')
          .get(id) as { c: number }).c
        for (const song of incoming) {
          const key = song.sourceSongId
          const position = key ? positions.get(key) : undefined
          if (position !== undefined) {
            update.run(
              song.title,
              song.artist,
              song.album ?? null,
              song.durationMs ?? null,
              song.identifiers ? JSON.stringify(song.identifiers) : null,
              song.coverUrl ?? null,
              id,
              position,
            )
            updated += 1
          } else {
            insert.run(
              id,
              nextPosition++,
              song.title,
              song.artist,
              song.album ?? null,
              song.durationMs ?? null,
              platform,
              key ?? null,
              song.identifiers ? JSON.stringify(song.identifiers) : null,
              song.coverUrl ?? null,
            )
            if (key) positions.set(key, nextPosition - 1)
            added += 1
          }
        }
        db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(now, id)
      })
      return { added, updated }
    },

    remove(id: string): void {
      db.prepare('DELETE FROM local_playlist_songs WHERE playlist_id = ?').run(id)
      db.prepare('DELETE FROM local_playlists WHERE id = ?').run(id)
    },

    songs(id: string): LocalPlaylistSong[] {
      const rows = db
        .prepare(
          `SELECT title, artist, album, duration_ms, source_platform, source_song_id,
                  identifiers, cover_url
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
        coverUrl: r.cover_url ?? undefined,
      }))
    },

    /** 整单替换写入（本地编辑以保存时全量覆盖为主） */
    replaceSongs(id: string, songs: LocalSongRecordInput[], now: string): void {
      withTransaction(db, () => {
        db.prepare('DELETE FROM local_playlist_songs WHERE playlist_id = ?').run(id)
        const insert = db.prepare(
          `INSERT INTO local_playlist_songs
            (playlist_id, position, title, artist, album, duration_ms,
             source_platform, source_song_id, identifiers, cover_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            s.coverUrl ?? null,
          )
        })
        db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(now, id)
      })
    },

    /** 存量歌曲封面回填：只写仍为空的行，不覆盖已有封面 */
    backfillSongCovers(
      id: string,
      covers: Array<{ position: number; coverUrl: string }>,
    ): void {
      if (covers.length === 0) return
      withTransaction(db, () => {
        const update = db.prepare(
          `UPDATE local_playlist_songs
           SET cover_url = ?
           WHERE playlist_id = ? AND position = ? AND (cover_url IS NULL OR cover_url = '')`,
        )
        for (const cover of covers) update.run(cover.coverUrl, id, cover.position)
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
             source_platform, source_song_id, identifiers, cover_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            s.coverUrl ?? null,
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
