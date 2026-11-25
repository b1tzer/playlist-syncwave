import type { PlatformPlaylist, PlatformSong } from '@core/models/platform'
import type { SqliteDb } from './sqlite'

interface PlaylistRow {
  id: string
  name: string
  /** 平台未提供歌曲数时为 NULL（如 Apple Music 资料库歌单） */
  song_count: number | null
  cover_url: string | null
  web_url: string | null
  app_url: string | null
  updated_at: number
}

interface SongRow {
  song_id: string
  title: string
  artist: string
  album: string | null
  cover_url: string | null
  duration_ms: number | null
  genre: string | null
}

/** 歌单列表与歌单歌曲的本地缓存存储（SQLite，整单替换写入） */
export function createPlaylistCacheStore(db: SqliteDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS playlist_cache_schema (
  scope TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL
);
-- 清理早期版本残留的全局作用域行（现按 platform 隔离）
DELETE FROM playlist_cache_schema WHERE scope NOT LIKE '%:%';
CREATE TABLE IF NOT EXISTS playlist_cache (
  platform TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  song_count INTEGER,
  cover_url TEXT,
  web_url TEXT,
  app_url TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (platform, id)
);
CREATE TABLE IF NOT EXISTS playlist_song_cache (
  platform TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  cover_url TEXT,
  duration_ms INTEGER,
  genre TEXT,
  PRIMARY KEY (platform, playlist_id, song_id)
);
CREATE TABLE IF NOT EXISTS playlist_song_meta (
  platform TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (platform, playlist_id)
);
`)

  /** 缓存 schema 版本是否匹配；不匹配视为无缓存（旧数据失效重新拉取） */
  function schemaMatches(scope: string, version: number): boolean {
    const row = db
      .prepare('SELECT version FROM playlist_cache_schema WHERE scope = ?')
      .get(scope) as { version: number } | undefined
    return row !== undefined && row.version === version
  }

  function setSchemaVersion(scope: string, version: number): void {
    db.prepare(
      `INSERT INTO playlist_cache_schema (scope, version) VALUES (?, ?)
       ON CONFLICT(scope) DO UPDATE SET version = excluded.version`,
    ).run(scope, version)
  }

  return {
    /** 平台歌单列表缓存；无缓存或 schema 版本不匹配返回 null（updatedAt 取该平台最新写入时间） */
    listPlaylists(
      platform: string,
      schemaVersion?: number,
    ): { list: PlatformPlaylist[]; updatedAt: number } | null {
      if (schemaVersion !== undefined && !schemaMatches(`playlists:${platform}`, schemaVersion)) {
        // 版本不匹配：清空该平台全部旧缓存，避免部分歌单残留旧格式数据
        db.prepare('DELETE FROM playlist_cache WHERE platform = ?').run(platform)
        return null
      }
      const rows = db
        .prepare('SELECT * FROM playlist_cache WHERE platform = ? ORDER BY rowid')
        .all(platform) as unknown as PlaylistRow[]
      if (rows.length === 0) return null
      const updatedAt = rows.reduce((max, r) => Math.max(max, r.updated_at), 0)
      return {
        list: rows.map((r) => ({
          id: r.id,
          name: r.name,
          songCount: r.song_count ?? undefined,
          coverUrl: r.cover_url ?? undefined,
          webUrl: r.web_url ?? undefined,
          appUrl: r.app_url ?? undefined,
        })),
        updatedAt,
      }
    },

    /** 整份替换某平台的歌单列表缓存 */
    savePlaylists(platform: string, list: PlatformPlaylist[], now: number, schemaVersion?: number): void {
      if (schemaVersion !== undefined) setSchemaVersion(`playlists:${platform}`, schemaVersion)
      db.prepare('DELETE FROM playlist_cache WHERE platform = ?').run(platform)
      const insert = db.prepare(
        `INSERT INTO playlist_cache
          (platform, id, name, song_count, cover_url, web_url, app_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const p of list) {
        insert.run(
          platform,
          p.id,
          p.name,
          // 平台未提供歌曲数时存 NULL（better-sqlite3 不绑定 undefined）
          p.songCount ?? null,
          p.coverUrl ?? null,
          p.webUrl ?? null,
          p.appUrl ?? null,
          now,
        )
      }
    },

    /** 失效某平台全部歌单列表缓存（如同步建单后） */
    invalidatePlaylists(platform: string): void {
      db.prepare('DELETE FROM playlist_cache WHERE platform = ?').run(platform)
    },

    /** 失效单个歌单的列表缓存（重命名/删除/歌曲增删后） */
    invalidatePlaylist(platform: string, playlistId: string): void {
      db.prepare('DELETE FROM playlist_cache WHERE platform = ? AND id = ?').run(
        platform,
        playlistId,
      )
    },

    /** 歌单歌曲缓存；无缓存或 schema 版本不匹配返回 null */
    listSongs(
      platform: string,
      playlistId: string,
      schemaVersion?: number,
    ): { songs: PlatformSong[]; updatedAt: number } | null {
      if (schemaVersion !== undefined && !schemaMatches(`songs:${platform}`, schemaVersion)) {
        // 版本不匹配：清空该平台全部歌曲旧缓存，避免残留旧格式数据
        db.prepare('DELETE FROM playlist_song_cache WHERE platform = ?').run(platform)
        db.prepare('DELETE FROM playlist_song_meta WHERE platform = ?').run(platform)
        return null
      }
      const rows = db
        .prepare(
          'SELECT * FROM playlist_song_cache WHERE platform = ? AND playlist_id = ? ORDER BY rowid',
        )
        .all(platform, playlistId) as unknown as SongRow[]
      if (rows.length === 0) return null
      const meta = db
        .prepare('SELECT updated_at FROM playlist_song_meta WHERE platform = ? AND playlist_id = ?')
        .get(platform, playlistId) as { updated_at: number } | undefined
      return {
        songs: rows.map((r) => ({
          id: r.song_id,
          title: r.title,
          artist: r.artist,
          album: r.album ?? undefined,
          coverUrl: r.cover_url ?? undefined,
          durationMs: r.duration_ms ?? undefined,
          genre: r.genre ?? undefined,
        })),
        updatedAt: meta?.updated_at ?? 0,
      }
    },

    /** 整单替换歌单歌曲缓存（先删后插，保持平台顺序） */
    saveSongs(
      platform: string,
      playlistId: string,
      songs: PlatformSong[],
      now: number,
      schemaVersion?: number,
    ): void {
      if (schemaVersion !== undefined) setSchemaVersion(`songs:${platform}`, schemaVersion)
      db.prepare('DELETE FROM playlist_song_cache WHERE platform = ? AND playlist_id = ?').run(
        platform,
        playlistId,
      )
      const insert = db.prepare(
        `INSERT INTO playlist_song_cache
          (platform, playlist_id, song_id, title, artist, album, cover_url, duration_ms, genre)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const s of songs) {
        insert.run(
          platform,
          playlistId,
          s.id,
          s.title,
          s.artist,
          s.album ?? null,
          s.coverUrl ?? null,
          s.durationMs ?? null,
          s.genre ?? null,
        )
      }
      db.prepare(
        `INSERT INTO playlist_song_meta (platform, playlist_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(platform, playlist_id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(platform, playlistId, now)
    },

    /** 失效歌单歌曲缓存（歌曲增删后） */
    invalidateSongs(platform: string, playlistId: string): void {
      db.prepare('DELETE FROM playlist_song_cache WHERE platform = ? AND playlist_id = ?').run(
        platform,
        playlistId,
      )
      db.prepare('DELETE FROM playlist_song_meta WHERE platform = ? AND playlist_id = ?').run(
        platform,
        playlistId,
      )
    },
  }
}

export type PlaylistCacheStore = ReturnType<typeof createPlaylistCacheStore>
