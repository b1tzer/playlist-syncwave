import { getDatabase } from './appDatabase'
import type { SyncTaskRecord } from '@core/models/sync'

export function upsertSyncTask(task: SyncTaskRecord): void {
  getDatabase().syncHistory.upsertTask(task)
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
