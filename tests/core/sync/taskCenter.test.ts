import { describe, expect, it } from 'vitest'
import type { SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import { deriveTaskCenterState } from '@core/sync/taskCenter'

const makeTask = (
  id: string,
  status: SyncTaskStatus,
  overrides: Partial<SyncTaskRecord> = {},
): SyncTaskRecord => ({
  id,
  name: `任务-${id}`,
  targetPlatform: 'netease',
  source: 'text-import',
  status,
  total: 10,
  added: 5,
  failed: 2,
  createdAt: '2026/11/27 10:00:00',
  createdAtMs: 0,
  progress: status === 'running' ? 0.5 : 1,
  failedDetail: status === 'failed' ? ['目标平台服务不可用'] : [],
  detail: [],
  rawInput: [],
  ...overrides,
})

const empty = () => ({
  seen: new Set<string>(),
  active: new Set<string>(),
  dismissed: new Set<string>(),
})

describe('deriveTaskCenterState — 右上角任务中心状态机', () => {
  it('新出现的 running 任务进入运行中展示，不产生结束通知', () => {
    const { seen, active } = empty()
    const derived = deriveTaskCenterState(
      [makeTask('t1', 'running')],
      seen,
      active,
      new Set(),
      true,
    )
    expect(derived.running.map((r) => r.id)).toEqual(['t1'])
    expect(derived.running[0]).toMatchObject({
      name: '任务-t1',
      progress: 0.5,
      total: 10,
    })
    expect(derived.finished).toEqual([])
    expect(derived.active.has('t1')).toBe(true)
  })

  it('running 转为 failed → 产生一次结束通知，附失败原因', () => {
    const { seen, active } = empty()
    const first = deriveTaskCenterState([makeTask('t1', 'running')], seen, active, new Set(), true)
    const second = deriveTaskCenterState(
      [makeTask('t1', 'failed')],
      first.seen,
      first.active,
      new Set(),
      true,
    )
    expect(second.running).toEqual([])
    expect(second.finished).toHaveLength(1)
    expect(second.finished[0]).toMatchObject({
      id: 't1',
      status: 'failed',
      reason: '目标平台服务不可用',
    })
    expect(second.active.has('t1')).toBe(false)
  })

  it('running 转为 done → 结束通知为成功，无失败原因', () => {
    const { seen, active } = empty()
    const first = deriveTaskCenterState([makeTask('t1', 'running')], seen, active, new Set(), true)
    const second = deriveTaskCenterState(
      [makeTask('t1', 'done')],
      first.seen,
      first.active,
      new Set(),
      true,
    )
    expect(second.finished).toHaveLength(1)
    expect(second.finished[0].status).toBe('done')
    expect(second.finished[0].reason).toBeNull()
  })

  it('已知的历史终态任务不重复弹出结束通知', () => {
    const { seen, active } = empty()
    const first = deriveTaskCenterState([makeTask('t1', 'failed')], seen, active, new Set(), true)
    // 恢复后的同一批任务再次渲染：不重复弹
    const second = deriveTaskCenterState(
      [makeTask('t1', 'failed')],
      first.seen,
      first.active,
      new Set(),
      true,
    )
    expect(second.finished).toEqual([])
  })

  it('首帧任务列表为空：保持未初始化，等待恢复批次到达（防止历史任务被当成新任务弹通知）', () => {
    const first = deriveTaskCenterState([], new Set(), new Set(), new Set(), false)
    expect(first.initialized).toBe(false)
    expect(first.finished).toEqual([])
    expect(first.running).toEqual([])
  })

  it('初始恢复批次（应用重启恢复的历史）整体归入已知，不弹结果；运行中的恢复任务正常展示', () => {
    const derived = deriveTaskCenterState(
      [makeTask('t-done', 'done'), makeTask('t-fail', 'failed'), makeTask('t-run', 'running')],
      new Set(),
      new Set(),
      new Set(),
      false, // 尚未初始化
    )
    expect(derived.initialized).toBe(true)
    expect(derived.finished).toEqual([])
    expect(derived.running.map((r) => r.id)).toEqual(['t-run'])
    expect(derived.seen.has('t-done')).toBe(true)
  })

  it('初始恢复后新任务（running 快照被合并、首帧即终态）仍会弹结束通知', () => {
    const first = deriveTaskCenterState([], new Set(), new Set(), new Set(), false)
    // 初始化后再出现新任务（可能 running 快照与终态同帧到达）
    const second = deriveTaskCenterState(
      [makeTask('t-new', 'stopped')],
      first.seen,
      first.active,
      new Set(),
      true,
    )
    expect(second.finished.map((f) => f.id)).toEqual(['t-new'])
  })

  it('已关闭的通知不再重复弹出', () => {
    const { seen, active } = empty()
    const first = deriveTaskCenterState([makeTask('t1', 'running')], seen, active, new Set(), true)
    const second = deriveTaskCenterState(
      [makeTask('t1', 'failed')],
      first.seen,
      first.active,
      new Set(),
      true,
    )
    expect(second.finished).toHaveLength(1)
    const third = deriveTaskCenterState(
      [makeTask('t1', 'failed')],
      second.seen,
      second.active,
      new Set(['t1']),
      true,
    )
    expect(third.finished).toEqual([])
  })

  it('多任务并发：各自独立跟踪运行与结束状态', () => {
    const { seen, active } = empty()
    const first = deriveTaskCenterState(
      [makeTask('t1', 'running'), makeTask('t2', 'running')],
      seen,
      active,
      new Set(),
      true,
    )
    const second = deriveTaskCenterState(
      [makeTask('t1', 'done'), makeTask('t2', 'running')],
      first.seen,
      first.active,
      new Set(),
      true,
    )
    expect(second.running.map((r) => r.id)).toEqual(['t2'])
    expect(second.finished.map((f) => f.id)).toEqual(['t1'])
  })
})
