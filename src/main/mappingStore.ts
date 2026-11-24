import type { SyncChoice } from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'
import type { SqliteDb } from './sqlite'

/** 跨平台歌曲映射记录（文本歌曲 → 某平台歌曲 ID） */
export interface SongMapping {
  id: number
  platform: string
  queryTitle: string
  queryArtist: string
  songId: string
  songTitle: string
  songArtist: string
  /** 匹配得分 0-1 */
  score: number
  /** 用户人工确认（choice 选择）的映射，优先级最高 */
  confirmed: number
  createdAt: string
}

interface MappingRow {
  id: number
  platform: string
  query_title: string
  query_artist: string
  song_id: string
  song_title: string
  song_artist: string
  score: number
  confirmed: number
  created_at: string
}

function rowToMapping(row: MappingRow): SongMapping {
  return {
    id: row.id,
    platform: row.platform,
    queryTitle: row.query_title,
    queryArtist: row.query_artist,
    songId: row.song_id,
    songTitle: row.song_title,
    songArtist: row.song_artist,
    score: row.score,
    confirmed: row.confirmed,
    createdAt: row.created_at,
  }
}

export function createMappingStore(db: SqliteDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS song_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  query_title TEXT NOT NULL,
  query_artist TEXT NOT NULL DEFAULT '',
  song_id TEXT NOT NULL,
  song_title TEXT NOT NULL,
  song_artist TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(platform, query_title, query_artist, song_id)
);
CREATE INDEX IF NOT EXISTS idx_mappings_lookup
  ON song_mappings (platform, query_title, query_artist);
`)

  return {
    /** 查询某首歌（歌名+歌手）在某平台的全部候选映射，人工确认优先 */
    findByQuery(platform: string, query: MatchQuery): SongMapping[] {
      const rows = db
        .prepare(
          `SELECT * FROM song_mappings
           WHERE platform = ? AND query_title = ? AND query_artist = ?
           ORDER BY confirmed DESC, score DESC`,
        )
        .all(platform, query.title, query.artist ?? '') as unknown as MappingRow[]
      return rows.map(rowToMapping)
    },

    /** 记录一次自动匹配结果 */
    saveAutoMatch(
      platform: string,
      query: MatchQuery,
      song: PlatformSong,
      score: number,
    ): void {
      db.prepare(
        `INSERT INTO song_mappings
          (platform, query_title, query_artist, song_id, song_title, song_artist, score, confirmed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(platform, query_title, query_artist, song_id) DO UPDATE SET
           score = excluded.score, song_title = excluded.song_title, song_artist = excluded.song_artist`,
      ).run(
        platform,
        query.title,
        query.artist ?? '',
        song.id,
        song.title,
        song.artist,
        score,
        new Date().toISOString(),
      )
    },

    /** 记录用户人工选择（choice 确认），confirmed=1 */
    saveConfirmed(platform: string, choice: SyncChoice, songId: string): void {
      const candidate = choice.candidates.find((c) => c.id === songId)
      if (!candidate) return
      const query = choice.query
      db.prepare(
        `INSERT INTO song_mappings
          (platform, query_title, query_artist, song_id, song_title, song_artist, score, confirmed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
         ON CONFLICT(platform, query_title, query_artist, song_id) DO UPDATE SET
           confirmed = 1, score = 1, song_title = excluded.song_title, song_artist = excluded.song_artist`,
      ).run(
        platform,
        query.title,
        query.artist ?? '',
        candidate.id,
        candidate.title,
        candidate.artist,
        new Date().toISOString(),
      )
    },

    /** 平台维度统计（用于设置页展示缓存规模） */
    countByPlatform(): Array<{ platform: string; count: number; confirmed: number }> {
      return db
        .prepare(
          `SELECT platform, COUNT(*) AS count, SUM(confirmed) AS confirmed
           FROM song_mappings GROUP BY platform`,
        )
        .all() as unknown as Array<{ platform: string; count: number; confirmed: number }>
    },

    clearPlatform(platform: string): void {
      db.prepare('DELETE FROM song_mappings WHERE platform = ?').run(platform)
    },
  }
}

export type MappingStore = ReturnType<typeof createMappingStore>
