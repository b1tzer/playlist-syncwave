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

  it('旧库补齐 created_at_ms 列（v3），存量行默认为 0', () => {
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

  it('v5：从任务 id 回填 created_at_ms，历史任务可显示带年月日的完整时间', () => {
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
})
