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

  it('幂等：重复执行不报错且版本不重复', () => {
    runMigrations(db)
    runMigrations(db)
    const rows = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
    expect(rows.c).toBe(1)
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
})
