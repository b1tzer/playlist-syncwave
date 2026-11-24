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

/** 列缺失时 ALTER TABLE 补齐（SQLite 不支持 ADD COLUMN IF NOT EXISTS） */
function addColumnIfMissing(db: SqliteDb, table: string, column: string, ddl: string): void {
  if (columnExists(db, table, column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

/**
 * 版本化增量迁移列表：只追加不修改，version 单调递增。
 * 初始建表仍由各 Store 的 CREATE TABLE IF NOT EXISTS 负责（幂等），
 * 迁移只处理存量库的结构演进。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'sync_tasks.detail 列补齐（T9 之前旧库）',
    up: (db) => {
      addColumnIfMissing(db, 'sync_tasks', 'detail', "detail TEXT NOT NULL DEFAULT '[]'")
    },
  },
  {
    version: 2,
    name: 'playlist_cache 重建：song_count 允许 NULL（平台未提供歌曲数时留空，如 Apple Music）',
    up: (db) => {
      // 旧表 song_count NOT NULL 且缓存的 Apple Music 歌曲数为虚构 0：
      // 缓存表可整体丢弃（迁移在 Store 建表之前运行，DROP 后按新 DDL 重建）
      db.exec('DROP TABLE IF EXISTS playlist_cache')
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
