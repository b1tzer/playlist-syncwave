import type { MatchQuery } from '@core/models/match'
import type { SyncItemResult, SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'

/** 成功/失败计数的统一口径：matched 计成功，failed/skipped 计失败，choice 不计入任何一侧 */
export interface TaskCounts {
  added: number
  failed: number
  /** 计数是否由逐首明细派生（明细为空时回退标量字段） */
  fromDetail: boolean
}

/**
 * 从逐首明细派生成功/失败计数。
 * 明细非空时它是权威口径——历史任务、异常路径下标量字段（added/failed）可能与明细脱节，
 * 行摘要与落库都必须以同一份明细为准，避免「失败 15」与「成功 15 首」并存。
 */
export function deriveTaskCounts(
  detail: SyncItemResult[],
  fallback: { added: number; failed: number },
): TaskCounts {
  if (detail.length === 0) return { ...fallback, fromDetail: false }
  let added = 0
  let failed = 0
  for (const item of detail) {
    if (item.status === 'matched') added++
    else if (item.status === 'failed' || item.status === 'skipped') failed++
  }
  return { added, failed, fromDetail: true }
}

/** 终态任务的第一条失败原因（行摘要与右上角任务中心展示用） */
export function firstFailureReason(
  task: Pick<SyncTaskRecord, 'failedDetail' | 'detail'>,
): string | null {
  if (task.failedDetail.length > 0) return task.failedDetail[0]
  const item = task.detail.find((d) => d.status === 'failed' || d.status === 'skipped')
  return item?.message ?? null
}

/**
 * 整体异常（建单/写入阶段崩溃）时把明细收敛为全失败：
 * - 已处理的 matched/choice 项改写为 failed（保留 query 与 index，供展示与重建输入）；
 * - 未广播到的输入项补全为 failed，保证 detail 与 total、failed 标量完全自洽。
 */
export function markTaskDetailFailed(
  detail: SyncItemResult[],
  queries: MatchQuery[],
  message: string,
): SyncItemResult[] {
  const byIndex = new Map(detail.map((d) => [d.index, d]))
  return queries.map((query, index) => {
    const existing = byIndex.get(index)
    if (existing && existing.status !== 'failed' && existing.status !== 'skipped') {
      return {
        ...existing,
        status: 'failed' as const,
        reason: 'task-failed' as const,
        message,
      }
    }
    if (existing) return existing
    return {
      index,
      query,
      status: 'failed' as const,
      reason: 'task-failed' as const,
      message,
    }
  })
}

/** 任务行摘要的展示形态：进行中显示进度，成功/停止显示计数，失败/中断显示失败原因 */
export function taskSummaryKind(status: SyncTaskStatus): 'progress' | 'counts' | 'failure' {
  switch (status) {
    case 'running':
      return 'progress'
    case 'done':
    case 'stopped':
      return 'counts'
    case 'failed':
    case 'interrupted':
      return 'failure'
  }
}
