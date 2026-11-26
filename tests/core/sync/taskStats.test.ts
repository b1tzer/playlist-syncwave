import { describe, expect, it } from 'vitest'
import type { MatchQuery } from '@core/models/match'
import type { SyncItemResult } from '@core/models/sync'
import {
  deriveTaskCounts,
  firstFailureReason,
  markTaskDetailFailed,
  taskSummaryKind,
} from '@core/sync/taskStats'

const q = (title: string): MatchQuery => ({ title, artist: '某人' })

const item = (
  index: number,
  status: SyncItemResult['status'],
  title = `歌${index}`,
): SyncItemResult => ({ index, query: q(title), status })

describe('deriveTaskCounts — 成功/失败计数统一口径', () => {
  it('明细非空：matched 计成功，failed/skipped 计失败，choice 不计入任何一侧', () => {
    const counts = deriveTaskCounts(
      [
        item(0, 'matched'),
        item(1, 'failed'),
        item(2, 'skipped'),
        item(3, 'choice'),
        item(4, 'matched'),
      ],
      { added: 99, failed: 99 },
    )
    expect(counts).toEqual({ added: 2, failed: 2, fromDetail: true })
  })

  it('明细为空（历史任务/异常路径）：回退标量字段', () => {
    expect(deriveTaskCounts([], { added: 7, failed: 3 })).toEqual({
      added: 7,
      failed: 3,
      fromDetail: false,
    })
  })

  it('全 matched 明细不再显示为失败（回归：失败 15 / 展开成功 15 首 的矛盾）', () => {
    const detail = Array.from({ length: 15 }, (_, i) => item(i, 'matched'))
    // 整体异常收敛后 detail 应被改写为 failed，派生计数与 failed=total 自洽
    const rewritten = markTaskDetailFailed(
      detail,
      detail.map((d) => d.query),
      '网络错误',
    )
    expect(deriveTaskCounts(rewritten, { added: 0, failed: 15 })).toEqual({
      added: 0,
      failed: 15,
      fromDetail: true,
    })
  })
})

describe('firstFailureReason — 失败原因取第一优先级', () => {
  it('failedDetail 优先', () => {
    expect(firstFailureReason({ failedDetail: ['原因A', '原因B'], detail: [] })).toBe('原因A')
  })

  it('failedDetail 为空时回退明细中的失败项 message', () => {
    const failed = { ...item(1, 'failed'), message: '写入失败' }
    expect(
      firstFailureReason({
        failedDetail: [],
        detail: [item(0, 'matched'), failed],
      }),
    ).toBe('写入失败')
  })

  it('都没有时返回 null', () => {
    expect(firstFailureReason({ failedDetail: [], detail: [item(0, 'matched')] })).toBeNull()
  })
})

describe('markTaskDetailFailed — 整体异常时明细收敛为全失败', () => {
  it('已处理的 matched/choice 改写为 failed，保留 query 与 index', () => {
    const detail: SyncItemResult[] = [
      { ...item(0, 'matched'), songId: 's1' },
      item(1, 'choice'),
      { ...item(2, 'skipped'), reason: 'skipped', message: '已跳过' },
    ]
    const queries = detail.map((d) => d.query)
    const out = markTaskDetailFailed(detail, queries, '任务中断')
    expect(out[0]).toMatchObject({
      index: 0,
      status: 'failed',
      reason: 'task-failed',
      message: '任务中断',
    })
    expect(out[1]).toMatchObject({
      index: 1,
      status: 'failed',
      reason: 'task-failed',
    })
    // 已经是失败/跳过的项保持原状
    expect(out[2]).toMatchObject({
      index: 2,
      status: 'skipped',
      reason: 'skipped',
    })
  })

  it('未广播到的输入项补全为 failed，detail 与 total 完全对齐', () => {
    const queries = [q('歌1'), q('歌2'), q('歌3')]
    const out = markTaskDetailFailed([item(0, 'matched')], queries, '崩溃')
    expect(out).toHaveLength(3)
    expect(out.map((d) => d.status)).toEqual(['failed', 'failed', 'failed'])
    expect(out[2].query).toEqual(queries[2])
  })
})

describe('taskSummaryKind — 行摘要展示形态', () => {
  it('running 显示进度；done/stopped 显示计数；failed/interrupted 显示失败原因', () => {
    expect(taskSummaryKind('running')).toBe('progress')
    expect(taskSummaryKind('done')).toBe('counts')
    expect(taskSummaryKind('stopped')).toBe('counts')
    expect(taskSummaryKind('failed')).toBe('failure')
    expect(taskSummaryKind('interrupted')).toBe('failure')
  })
})
