import type { SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import { firstFailureReason } from './taskStats'

/** 右上角任务中心：运行中条目 */
export interface TaskCenterRunningItem {
  id: string
  name: string
  targetPlatform: string
  progress: number
  total: number
}

/** 右上角任务中心：新结束的任务（需弹出结果通知） */
export interface TaskCenterFinishedItem {
  id: string
  name: string
  targetPlatform: string
  status: SyncTaskStatus
  reason: string | null
}

export interface TaskCenterDerived {
  running: TaskCenterRunningItem[]
  finished: TaskCenterFinishedItem[]
  /** 更新后的已见任务集合 */
  seen: Set<string>
  /** 更新后的「正在观察运行状态」任务集合 */
  active: Set<string>
  /** 是否已完成初始恢复（首屏任务批量归入历史，不弹结果通知） */
  initialized: boolean
}

const TERMINAL_STATUSES: SyncTaskStatus[] = ['done', 'failed', 'stopped', 'interrupted']

/**
 * 右上角任务中心的状态派生（纯函数，便于测试）：
 * - 初始恢复：组件首屏收到的一批任务（可能是应用重启恢复的历史）只归入 seen/active，
 *   不弹结果通知，避免每次启动历史任务全部弹出；
 * - 新出现的 running 任务进入「运行中」展示；
 * - 正在运行的任务转为终态（或新任务首帧即终态）→ 产生一次「结束通知」，成功/失败/原因随附；
 * - 已关闭的通知（dismissed）与已知的历史终态任务不再重复弹出。
 */
export function deriveTaskCenterState(
  tasks: SyncTaskRecord[],
  seen: ReadonlySet<string>,
  active: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
  initialized: boolean,
): TaskCenterDerived {
  const nextSeen = new Set(seen)
  const nextActive = new Set<string>()
  const running: TaskCenterRunningItem[] = []
  const finished: TaskCenterFinishedItem[] = []

  // 初始恢复：应用启动后的首批任务整体视为历史（含恢复执行的 running 任务）。
  // 首帧任务列表仍为空时不推进初始化：等恢复批次到达再整体归入历史，
  // 否则历史终态任务会被当成「新任务」弹通知轰炸。
  if (!initialized) {
    if (tasks.length === 0) {
      return { running, finished, seen: nextSeen, active: nextActive, initialized: false }
    }
    for (const task of tasks) {
      nextSeen.add(task.id)
      if (task.status === 'running') {
        nextActive.add(task.id)
        running.push({
          id: task.id,
          name: task.name,
          targetPlatform: task.targetPlatform,
          progress: task.progress,
          total: task.total,
        })
      }
    }
    return {
      running,
      finished,
      seen: nextSeen,
      active: nextActive,
      initialized: true,
    }
  }

  for (const task of tasks) {
    const isNew = !nextSeen.has(task.id)
    nextSeen.add(task.id)
    if (task.status === 'running') {
      nextActive.add(task.id)
      running.push({
        id: task.id,
        name: task.name,
        targetPlatform: task.targetPlatform,
        progress: task.progress,
        total: task.total,
      })
      continue
    }
    // 终态：仅「本次会话新出现」或「此前正在运行」的任务产生结束通知
    const wasRunning = active.has(task.id)
    if (!TERMINAL_STATUSES.includes(task.status)) continue
    if (isNew || wasRunning) {
      if (!dismissed.has(task.id)) {
        finished.push({
          id: task.id,
          name: task.name,
          targetPlatform: task.targetPlatform,
          status: task.status,
          reason: firstFailureReason(task),
        })
      }
    }
  }
  return {
    running,
    finished,
    seen: nextSeen,
    active: nextActive,
    initialized: true,
  }
}
