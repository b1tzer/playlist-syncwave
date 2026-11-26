import type { SqliteDb } from './sqlite'

interface Migration {
  version: number
  name: string
  up: (db: SqliteDb) => void
}

/** 检查列是否存在（pragma table_info，避免依赖异常控制流） */
function columnExists(db: SqliteDb, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

/** 检查表是否存在（全新库尚无业务表时用于跳过补丁） */
function tableExists(db: SqliteDb, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined
  return row !== undefined
}

/** 列缺失时 ALTER TABLE 补齐（SQLite 不支持 ADD COLUMN IF NOT EXISTS） */
function addColumnIfMissing(db: SqliteDb, table: string, column: string, ddl: string): void {
  if (columnExists(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

/**
 * 版本化增量迁移列表。
 *
 * 正式发布前：发布早期的结构演进（v1~v6）已压缩为下方单一「基线迁移」，
 * 覆盖内测旧库的全部差异，全新库（表不存在）自动跳过、由 Store 的最新 DDL 直接建表。
 *
 * 正式发布后：只追加、不修改、不删除，version 单调递增。
 * 存量用户库依赖完整迁移链补齐「任意历史版本 → 最新」的结构差异
 * （runMigrations 按 schema_migrations 的 MAX(version) 跳过已执行项），
 * 删除中间任何一项都会让停在旧版本的用户库永远缺失该次结构演进。
 * 每个迁移必须幂等，且对「表可能不存在」的全新库安全（补丁需包在 tableExists 内）。
 * 初始建表仍由各 Store 的 CREATE TABLE IF NOT EXISTS 负责（幂等），
 * 迁移只处理存量库的结构演进。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 6,
    name: '发布前基线：合并 v1~v6 全部结构演进（幂等；全新库表不存在时自动跳过）',
    up: (db) => {
      // sync_tasks 存在（内测旧库）时补齐历史演进列并回填精确创建时间戳；
      // 全新库此时尚无该表，跳过补丁，随后由 Store 的最新 DDL 直接建表。
      if (tableExists(db, 'sync_tasks')) {
        addColumnIfMissing(db, 'sync_tasks', 'detail', "detail TEXT NOT NULL DEFAULT '[]'")
        addColumnIfMissing(db, 'sync_tasks', 'created_at_ms', 'created_at_ms INTEGER NOT NULL DEFAULT 0')
        addColumnIfMissing(db, 'sync_tasks', 'raw_input', "raw_input TEXT NOT NULL DEFAULT '[]'")
        addColumnIfMissing(db, 'sync_tasks', 'playlist_id', "playlist_id TEXT NOT NULL DEFAULT ''")
        // 任务 id 形如 task-<Date.now()>（历史主进程兜底为 sync-<Date.now()>-<rand>），
        // 从中恢复精确创建时间戳；展示层按当前时区实时格式化，历史任务即可显示带年月日的完整时间。
        // id 无法解析的行保持 0，展示回退存储的 created_at 字符串。
        const rows = db
          .prepare('SELECT id FROM sync_tasks WHERE created_at_ms = 0')
          .all() as Array<{ id: string }>
        const update = db.prepare('UPDATE sync_tasks SET created_at_ms = ? WHERE id = ?')
        for (const row of rows) {
          const match = row.id.match(/^(?:task|sync)-(\d{13})/)
          if (!match) continue
          update.run(Number(match[1]), row.id)
        }
      }
      // playlist_cache 缓存表可整体丢弃（song_count NULL 等演进），由 Store 按最新 DDL 重建；
      // 内测库缓存被清一次（下次访问重新拉取），无数据安全风险
      db.exec('DROP TABLE IF EXISTS playlist_cache')
    },
  },
  {
    version: 7,
    name: '本地歌单保留平台唯一标识（来源歌单定位 + 歌曲次级 id）',
    up: (db) => {
      if (tableExists(db, 'local_playlists')) {
        addColumnIfMissing(db, 'local_playlists', 'source_platform', 'source_platform TEXT')
        addColumnIfMissing(db, 'local_playlists', 'source_playlist_id', 'source_playlist_id TEXT')
        addColumnIfMissing(db, 'local_playlists', 'source_web_url', 'source_web_url TEXT')
        addColumnIfMissing(db, 'local_playlists', 'source_app_url', 'source_app_url TEXT')
        addColumnIfMissing(db, 'local_playlists', 'source_owner_id', 'source_owner_id TEXT')
        addColumnIfMissing(db, 'local_playlists', 'extra_ids', 'extra_ids TEXT')
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_local_playlists_source
             ON local_playlists (source_platform, source_playlist_id)`,
        )
      }
      if (tableExists(db, 'local_playlist_songs')) {
        addColumnIfMissing(db, 'local_playlist_songs', 'source_platform', 'source_platform TEXT')
        addColumnIfMissing(db, 'local_playlist_songs', 'source_song_id', 'source_song_id TEXT')
        addColumnIfMissing(db, 'local_playlist_songs', 'identifiers', 'identifiers TEXT')
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_local_playlist_songs_source
             ON local_playlist_songs (playlist_id, source_platform, source_song_id)`,
        )
      }
    },
  },
]

/** 应用所有未执行的迁移（按版本序，每个迁移独立事务并记录版本） */
export function runMigrations(db: SqliteDb): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
`)
  const appliedRow = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get() as { v: number }
  const current = Number(appliedRow.v)

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const run = db.transaction
      ? db.transaction(() => {
          migration.up(db)
          record.run(migration.version, migration.name, new Date().toISOString())
        })
      : () => {
          migration.up(db)
          record.run(migration.version, migration.name, new Date().toISOString())
        }
    run()
  }
}
