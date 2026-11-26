import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../src/main/migrations'

/** 模拟 T9 之前旧库：sync_tasks 无 detail 列 */
function createLegacyDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
CREATE TABLE sync_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_platform TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  added INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  progress REAL NOT NULL,
  failed_detail TEXT NOT NULL
)
`)
  return db
}

describe('runMigrations — 版本化迁移', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createLegacyDb()
  })

  it('旧库补齐 detail 列并记录版本', () => {
    runMigrations(db)
    const cols = (db.pragma('table_info(sync_tasks)') as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('detail')
    const row = db.prepare('SELECT version FROM schema_migrations').get() as { version: number }
    expect(row.version).toBeGreaterThanOrEqual(1)
  })

  it('基线补齐 created_at_ms 列，存量行默认为 0', () => {
    runMigrations(db)
    const cols = (db.pragma('table_info(sync_tasks)') as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('created_at_ms')
    // 迁移前插入的存量行：时间戳无法恢复，保持默认 0
    db.prepare(
      `INSERT INTO sync_tasks
       (id, name, target_platform, source, status, total, added, failed, created_at, created_at_ms, progress, failed_detail, detail)
       VALUES ('old', '旧任务', 'netease', 'text-import', 'done', 1, 1, 0, '2026-11-01', 0, 1, '[]', '[]')`,
    ).run()
    const row = db.prepare('SELECT created_at_ms FROM sync_tasks WHERE id = ?').get('old') as {
      created_at_ms: number
    }
    expect(row.created_at_ms).toBe(0)
  })

  it('基线：从任务 id 回填 created_at_ms，历史任务可显示带年月日的完整时间', () => {
    // 模拟迁移前的老库数据：T9 之前无 detail 列，created_at 仅时刻
    db.prepare(
      `INSERT INTO sync_tasks
       (id, name, target_platform, source, status, total, added, failed, created_at, progress, failed_detail)
       VALUES
         ('task-1764043200000', '旧任务A', 'netease', 'text-import', 'done', 1, 1, 0, '11:35:40', 1, '[]'),
         ('sync-1764043260000-abc123', '旧任务B', 'netease', 'text-import', 'done', 1, 1, 0, '12:01:00', 1, '[]'),
         ('legacy-fixed-id', '旧任务C', 'netease', 'text-import', 'done', 1, 1, 0, '13:00:00', 1, '[]')`,
    ).run()
    runMigrations(db)
    const ms = (id: string) =>
      (db.prepare('SELECT created_at_ms FROM sync_tasks WHERE id = ?').get(id) as {
        created_at_ms: number
      }).created_at_ms
    expect(ms('task-1764043200000')).toBe(1764043200000)
    expect(ms('sync-1764043260000-abc123')).toBe(1764043260000)
    // id 无法解析时间戳的行保持 0，展示回退存储的可读字符串
    expect(ms('legacy-fixed-id')).toBe(0)
  })

  it('幂等：重复执行不报错且版本不重复', () => {
    runMigrations(db)
    const first = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
    expect(first.c).toBeGreaterThanOrEqual(1)
    runMigrations(db)
    const second = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
    expect(second.c).toBe(first.c)
  })

  it('新库（列已存在）执行迁移不破坏数据', () => {
    runMigrations(db)
    db.prepare(
      `INSERT INTO sync_tasks
       (id, name, target_platform, source, status, total, added, failed, created_at, progress, failed_detail, detail)
       VALUES ('t1', 'n', 'netease', 'text-import', 'done', 1, 1, 0, '2024-01-01', 1, '[]', '[]')`,
    ).run()
    runMigrations(db)
    const row = db.prepare('SELECT detail FROM sync_tasks WHERE id = ?').get('t1') as {
      detail: string
    }
    expect(row.detail).toBe('[]')
  })

  it('全新库（无任何业务表）执行迁移不报错：补丁跳过，由 Store 建最新表', () => {
    const fresh = new Database(':memory:')
    expect(() => runMigrations(fresh)).not.toThrow()
    const version = fresh
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number }
    expect(version.v).toBe(7)
    // 迁移不建业务表：建表仍由各 Store 负责
    const tables = fresh
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).not.toContain('sync_tasks')
  })

  it('v7：存量本地歌单表补齐来源/唯一标识列，索引存在且幂等', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
CREATE TABLE local_playlists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE local_playlist_songs (
  playlist_id TEXT NOT NULL REFERENCES local_playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '', album TEXT, duration_ms INTEGER,
  PRIMARY KEY (playlist_id, position)
);
INSERT INTO local_playlists (id, name, created_at, updated_at)
  VALUES ('p1', '旧歌单', '2024-01-01', '2024-01-01');
INSERT INTO local_playlist_songs (playlist_id, position, title, artist)
  VALUES ('p1', 0, '晴天', '周杰伦');
`)
    runMigrations(legacy)
    const playlistCols = (legacy.pragma('table_info(local_playlists)') as Array<{ name: string }>).map(
      (c) => c.name,
    )
    const songCols = (
      legacy.pragma('table_info(local_playlist_songs)') as Array<{ name: string }>
    ).map((c) => c.name)
    expect(playlistCols).toEqual(
      expect.arrayContaining([
        'source_platform',
        'source_playlist_id',
        'source_web_url',
        'source_app_url',
        'source_owner_id',
        'extra_ids',
      ]),
    )
    expect(songCols).toEqual(
      expect.arrayContaining(['source_platform', 'source_song_id', 'identifiers']),
    )
    const indexes = (
      legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(indexes).toContain('idx_local_playlists_source')
    expect(indexes).toContain('idx_local_playlist_songs_source')
    const song = legacy
      .prepare('SELECT title FROM local_playlist_songs WHERE playlist_id = ?')
      .get('p1') as { title: string }
    expect(song.title).toBe('晴天')
    expect(() => runMigrations(legacy)).not.toThrow()
    const versions = (
      legacy.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
    ).map((r) => r.version)
    expect(versions.filter((v) => v === 7)).toHaveLength(1)
    legacy.close()
  })
})
