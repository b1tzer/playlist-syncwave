import { getDatabase } from './appDatabase'
import { activeSyncTaskIds } from './syncPipeline'
import type { SyncTaskRecord } from '@core/models/sync'

export function upsertSyncTask(task: SyncTaskRecord): void {
  getDatabase().syncHistory.upsertTask(task)
}

/**
 * 读取前归因残留 running：排除正在执行与等待确认的任务，其余（终态写回丢失的残留）
 * 归为 interrupted。覆盖窗口 reload 后主进程不重启、启动期 finalizeInterrupted 不再执行的场景，
 * 避免同步历史出现永不结束的「进行中」。
 */
export function reconcileStaleRunningTasks(): number {
  return getDatabase().syncHistory.finalizeStaleRunning(activeSyncTaskIds())
}

export function listSyncTasks(): SyncTaskRecord[] {
  return getDatabase().syncHistory.listTasks()
}

export function removeSyncTask(id: string): void {
  getDatabase().syncHistory.removeTask(id)
}

export function clearSyncTasks(): void {
  getDatabase().syncHistory.clearTasks()
}
