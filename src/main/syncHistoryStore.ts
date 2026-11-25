import type { SyncItemResult, SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import type { SqliteDb } from './sqlite'

interface TaskRow {
  id: string
  name: string
  target_platform: string
  source: string
  status: SyncTaskStatus
  total: number
  added: number
  failed: number
  created_at: string
  created_at_ms: number
  progress: number
  failed_detail: string
  detail: string
}

const INTERRUPTED_DETAIL = ['任务中断：应用在同步完成前退出']

const UPSERT_SQL = `
INSERT INTO sync_tasks
  (id, name, target_platform, source, status, total, added, failed, created_at, created_at_ms, progress, failed_detail, detail)
VALUES
  (@id, @name, @targetPlatform, @source, @status, @total, @added, @failed, @createdAt, @createdAtMs, @progress, @failedDetail, @detail)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  target_platform = excluded.target_platform,
  source = excluded.source,
  status = excluded.status,
  total = excluded.total,
  added = excluded.added,
  failed = excluded.failed,
  created_at = excluded.created_at,
  created_at_ms = excluded.created_at_ms,
  progress = excluded.progress,
  failed_detail = excluded.failed_detail,
  detail = excluded.detail
`

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as string[]
  } catch {
    // 历史脏数据按空处理
  }
  return []
}

function parseDetail(raw: string | undefined): SyncItemResult[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as SyncItemResult[]
  } catch {
    // 历史脏数据按空处理
  }
  return []
}

function rowToTask(row: TaskRow): SyncTaskRecord {
  return {
    id: row.id,
    name: row.name,
    targetPlatform: row.target_platform,
    source: row.source,
    status: row.status,
    total: row.total,
    added: row.added,
    failed: row.failed,
    createdAt: row.created_at,
    createdAtMs: row.created_at_ms,
    progress: row.progress,
    failedDetail: parseStringArray(row.failed_detail),
    detail: parseDetail(row.detail),
  }
}

export function createSyncHistoryStore(db: SqliteDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS sync_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_platform TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL,
  added INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL,
  failed_detail TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '[]'
)
`)

  return {
    /** 新增或更新一条任务记录 */
    upsertTask(task: SyncTaskRecord): void {
      db.prepare(UPSERT_SQL).run({
        id: task.id,
        name: task.name,
        targetPlatform: task.targetPlatform,
        source: task.source,
        status: task.status,
        total: task.total,
        added: task.added,
        failed: task.failed,
        createdAt: task.createdAt,
        createdAtMs: task.createdAtMs ?? 0,
        progress: task.progress,
        failedDetail: JSON.stringify(task.failedDetail),
        detail: JSON.stringify(task.detail),
      })
    },

    /**
     * 按创建时间倒序返回全部任务：
     * 精确时间戳优先（新任务），缺失的旧数据（0）以 created_at 兜底排后。
     */
    listTasks(): SyncTaskRecord[] {
      const rows = db
        .prepare('SELECT * FROM sync_tasks ORDER BY created_at_ms DESC, created_at DESC')
        .all() as unknown as TaskRow[]
      return rows.map(rowToTask)
    },

    /** 删除单条任务 */
    removeTask(id: string): void {
      db.prepare('DELETE FROM sync_tasks WHERE id = ?').run(id)
    },

    /** 清空全部任务 */
    clearTasks(): void {
      db.prepare('DELETE FROM sync_tasks').run()
    },

    /** 把「running」残留状态（上次异常退出）归为 interrupted，并写入中断原因 */
    finalizeInterrupted(): number {
      const result = db
        .prepare(
          `UPDATE sync_tasks
             SET status = 'interrupted',
                 failed_detail = CASE
                   WHEN failed_detail = '[]' THEN ?
                   ELSE failed_detail
                 END
           WHERE status = 'running'`,
        )
        .run(JSON.stringify(INTERRUPTED_DETAIL))
      return result.changes
    },
  }
}

export type SyncHistoryStore = ReturnType<typeof createSyncHistoryStore>
