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
 * 版本化增量迁移列表：只追加、不修改、不删除，version 单调递增。
 * 存量用户库依赖完整迁移链补齐「任意历史版本 → 最新」的结构差异
 * （runMigrations 按 schema_migrations 的 MAX(version) 跳过已执行项），
 * 删除中间任何一项都会让停在旧版本的用户库永远缺失该次结构演进。
 * 每个迁移必须幂等：新库会从 0 开始跑全链，且重复执行不得报错。
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
  {
    version: 3,
    name: 'sync_tasks.created_at_ms 列补齐：精确时间戳用于同步中心排序',
    up: (db) => {
      // 存量行时间戳无法从仅含时刻的 created_at 恢复，补 0；查询侧以 created_at 兜底
      addColumnIfMissing(db, 'sync_tasks', 'created_at_ms', 'created_at_ms INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    version: 4,
    name: 'sync_tasks.raw_input 列补齐：保存同步原始输入清单（重新执行时直接复用）',
    up: (db) => {
      // 旧任务无原始输入记录：补空数组；重新执行时回退按 detail 的 index 重建
      addColumnIfMissing(db, 'sync_tasks', 'raw_input', "raw_input TEXT NOT NULL DEFAULT '[]'")
    },
  },
  {
    version: 5,
    name: 'sync_tasks.created_at_ms 回填：从任务 id 提取创建时间戳，历史任务补全年月日显示',
    up: (db) => {
      addColumnIfMissing(db, 'sync_tasks', 'created_at_ms', 'created_at_ms INTEGER NOT NULL DEFAULT 0')
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
