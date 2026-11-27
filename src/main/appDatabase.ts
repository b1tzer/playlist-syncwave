import { app } from 'electron'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createSyncHistoryStore, type SyncHistoryStore } from './syncHistoryStore'
import { createSettingsStore, type SettingsStore } from './settingsStore'
import { createMappingStore, type MappingStore } from './mappingStore'
import { createPlaylistCacheStore, type PlaylistCacheStore } from './playlistCacheStore'
import { createLocalPlaylistStore, type LocalPlaylistStore } from './localPlaylistStore'
import { createEncyclopediaStore, type EncyclopediaStore } from './encyclopediaStore'
import { runMigrations } from './migrations'
import type { SyncTaskRecord } from '@core/models/sync'
import type { SqliteDb } from './sqlite'

/** 应用 SQLite 数据库：统一打开连接，初始化全部业务表 */
export interface AppDatabase {
  syncHistory: SyncHistoryStore
  settings: SettingsStore
  mappings: MappingStore
  playlistCache: PlaylistCacheStore
  localPlaylists: LocalPlaylistStore
  encyclopedia: EncyclopediaStore
}

let instance: AppDatabase | null = null

/**
 * 上次异常退出留下的 running 任务快照（finalizeInterrupted 归因前捕获）：
 * app ready 后由恢复执行流程消费，实现「重启自动继续执行」。
 */
let pendingResumeSnapshot: SyncTaskRecord[] = []

/** 旧版 sync-history.db 存在时，把数据搬到 app.db 后删除旧文件 */
function migrateLegacyHistory(db: SqliteDb): void {
  const userData = app.getPath('userData')
  const legacyPath = join(userData, 'sync-history.db')
  if (!existsSync(legacyPath)) return

  try {
    const legacy = createRequire(import.meta.url)('better-sqlite3')(legacyPath, {
      readonly: true,
    }) as SqliteDb
    try {
      const rows = legacy
        .prepare('SELECT * FROM sync_tasks')
        .all() as unknown as Array<Record<string, unknown>>
      if (rows.length > 0) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO sync_tasks
            (id, name, target_platform, source, status, total, added, failed, created_at, progress, failed_detail)
           VALUES (@id, @name, @target_platform, @source, @status, @total, @added, @failed, @created_at, @progress, @failed_detail)`,
        )
        for (const row of rows) insert.run(row)
      }
    } finally {
      legacy.close?.()
    }
    // 迁移成功后清理旧库（连同 WAL 文件）
    for (const suffix of ['', '-wal', '-shm']) {
      const p = legacyPath + suffix
      if (existsSync(p)) rmSync(p, { force: true })
    }
  } catch {
    // 迁移失败不阻塞启动，旧文件保留可下次重试
  }
}

export function getDatabase(): AppDatabase {
  if (!instance) {
    // CJS native 模块：内联 createRequire，避免与 electron-vite 注入的 require 冲突
    const Database = createRequire(import.meta.url)('better-sqlite3')
    const dbPath = join(app.getPath('userData'), 'app.db')
    const db = new Database(dbPath) as SqliteDb
    db.pragma?.('journal_mode = WAL')
    // 版本化 schema 迁移先行（存量库结构演进，幂等）
    runMigrations(db)
    instance = {
      syncHistory: createSyncHistoryStore(db),
      settings: createSettingsStore(db),
      mappings: createMappingStore(db),
      playlistCache: createPlaylistCacheStore(db),
      localPlaylists: createLocalPlaylistStore(db),
      encyclopedia: createEncyclopediaStore(db),
    }
    // 旧库数据迁移（幂等：旧文件删掉后不再执行）
    migrateLegacyHistory(db)
    // 先快照 running 残留（供恢复执行），再归因：无法自动恢复的任务由恢复流程补充失败原因
    pendingResumeSnapshot = instance.syncHistory
      .listTasks()
      .filter((t) => t.status === 'running')
    instance.syncHistory.finalizeInterrupted()
  }
  return instance
}

/**
 * 取出待恢复的 running 任务快照（一次性消费）。
 * 必须在 getDatabase 初始化之后调用：快照在 finalizeInterrupted 归因前捕获。
 */
export function takePendingResumeTasks(): SyncTaskRecord[] {
  const tasks = pendingResumeSnapshot
  pendingResumeSnapshot = []
  return tasks
}
