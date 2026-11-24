import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSyncHistoryStore } from '../../src/main/syncHistoryStore'
import { runMigrations } from '../../src/main/migrations'
import type { SyncItemResult, SyncTaskRecord } from '@core/models/sync'

function makeItem(overrides: Partial<SyncItemResult> = {}): SyncItemResult {
  return {
    index: 0,
    query: { title: '晴天', artist: '周杰伦' },
    status: 'matched',
    songId: '1',
    ...overrides,
  }
}

function makeTask(overrides: Partial<SyncTaskRecord> = {}): SyncTaskRecord {
  return {
    id: 'task-1',
    name: '测试歌单',
    targetPlatform: 'netease',
    source: '文本导入',
    status: 'done',
    total: 10,
    added: 8,
    failed: 2,
    createdAt: '2026-11-24T10:00:00.000Z',
    progress: 1,
    failedDetail: ['未找到匹配歌曲：A', '未找到匹配歌曲：B'],
    detail: [makeItem({ index: 0 }), makeItem({ index: 1, query: { title: 'A' }, status: 'failed', reason: 'no-match', message: '未找到' })],
    ...overrides,
  }
}

describe('syncHistoryStore — SQLite 持久化', () => {
  let store: ReturnType<typeof createSyncHistoryStore>
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    store = createSyncHistoryStore(db)
  })

  it('新增后可按创建时间倒序查询', () => {
    store.upsertTask(makeTask({ id: 'a', createdAt: '2026-11-24T10:00:00.000Z', name: '早' }))
    store.upsertTask(makeTask({ id: 'b', createdAt: '2026-11-24T11:00:00.000Z', name: '晚' }))
    const tasks = store.listTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe('b')
    expect(tasks[1].id).toBe('a')
  })

  it('同 id 再次写入为更新而非重复插入', () => {
    store.upsertTask(makeTask({ id: 'x', status: 'running', progress: 0.3 }))
    store.upsertTask(makeTask({ id: 'x', status: 'done', progress: 1, added: 8 }))
    const tasks = store.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('done')
    expect(tasks[0].progress).toBe(1)
  })

  it('failedDetail JSON 往返无损', () => {
    const detail = ['失败1', '失败2', '含"引号"与,逗号']
    store.upsertTask(makeTask({ id: 'y', failedDetail: detail }))
    expect(store.listTasks()[0].failedDetail).toEqual(detail)
  })

  it('removeTask 删除指定任务', () => {
    store.upsertTask(makeTask({ id: 'a' }))
    store.upsertTask(makeTask({ id: 'b' }))
    store.removeTask('a')
    const tasks = store.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('b')
  })

  it('clearTasks 清空全部', () => {
    store.upsertTask(makeTask({ id: 'a' }))
    store.upsertTask(makeTask({ id: 'b' }))
    store.clearTasks()
    expect(store.listTasks()).toHaveLength(0)
  })

  it('finalizeInterrupted 把残留 running 归为 interrupted', () => {
    store.upsertTask(makeTask({ id: 'a', status: 'running' }))
    store.upsertTask(makeTask({ id: 'b', status: 'done' }))
    const changes = store.finalizeInterrupted()
    expect(changes).toBe(1)
    const tasks = store.listTasks()
    expect(tasks.find((t) => t.id === 'a')?.status).toBe('interrupted')
    expect(tasks.find((t) => t.id === 'b')?.status).toBe('done')
  })

  it('finalizeInterrupted 为无详情的中断任务写入失败原因', () => {
    store.upsertTask(makeTask({ id: 'a', status: 'running', failedDetail: [] }))
    store.finalizeInterrupted()
    const task = store.listTasks().find((t) => t.id === 'a')
    expect(task?.failedDetail).toEqual(['任务中断：应用在同步完成前退出'])
  })

  it('finalizeInterrupted 保留已有失败详情', () => {
    store.upsertTask(makeTask({ id: 'a', status: 'running', failedDetail: ['已有原因'] }))
    store.finalizeInterrupted()
    const task = store.listTasks().find((t) => t.id === 'a')
    expect(task?.failedDetail).toEqual(['已有原因'])
  })

  it('空库查询返回空数组，不抛异常', () => {
    expect(store.listTasks()).toEqual([])
    expect(store.finalizeInterrupted()).toBe(0)
  })

  it('detail 明细 JSON 往返无损（T9）', () => {
    const detail = [
      makeItem({ index: 0, status: 'matched', songId: '1' }),
      makeItem({
        index: 1,
        query: { title: '勇气', artist: '梁静茹' },
        status: 'failed',
        reason: 'unresolved',
        message: '同歌不同作者，未选择版本',
      }),
      makeItem({
        index: 2,
        query: { title: '坏歌' },
        status: 'skipped',
        reason: 'skipped',
        message: '已跳过：坏歌',
      }),
    ]
    store.upsertTask(makeTask({ id: 'z', detail }))
    expect(store.listTasks()[0].detail).toEqual(detail)
  })

  it('旧库（无 detail 列）升级：迁移框架补齐后可正常读写（T9）', () => {
    // 模拟 T9 之前的旧表结构
    db.exec(`
      DROP TABLE sync_tasks;
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
      );
      INSERT INTO sync_tasks VALUES
        ('old-1', '旧任务', 'netease', '文本导入', 'done', 5, 5, 0, '2026-11-01T00:00:00.000Z', 1, '[]');
    `)
    // 升级路径：版本化迁移在 store 创建前执行（与 appDatabase 启动顺序一致）
    runMigrations(db)
    const upgraded = createSyncHistoryStore(db)
    const tasks = upgraded.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('old-1')
    expect(tasks[0].detail).toEqual([])
    upgraded.upsertTask(makeTask({ id: 'old-1', status: 'stopped', detail: [makeItem()] }))
    expect(upgraded.listTasks()[0].status).toBe('stopped')
    expect(upgraded.listTasks()[0].detail).toHaveLength(1)
  })
})
