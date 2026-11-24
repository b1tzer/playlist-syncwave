import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSyncHistoryStore } from '../../src/main/syncHistoryStore'
import type { SyncTaskRecord } from '@core/models/sync'

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
})
