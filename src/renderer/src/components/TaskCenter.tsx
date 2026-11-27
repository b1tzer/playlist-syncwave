import { useEffect, useRef } from 'react'
import type { SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import { deriveTaskCenterState } from '@core/sync/taskCenter'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/translations'
import { userFacingErrorMessage } from '../utils/ipcError'
import { closeTaskToast, notify, notifyTask, type ToastType } from './toast'

/** 同屏最多展示的运行中任务卡，超出仅显示汇总 */
const MAX_RUNNING = 3

/** 结果通知：任务状态 → 通知类型与文案 */
const FINISHED_TOAST: Record<SyncTaskStatus, { type: ToastType; labelKey: TranslationKey }> = {
  done: { type: 'success', labelKey: 'taskCenter.done' },
  failed: { type: 'error', labelKey: 'taskCenter.failed' },
  stopped: { type: 'warning', labelKey: 'taskCenter.stopped' },
  interrupted: { type: 'warning', labelKey: 'taskCenter.interrupted' },
  running: { type: 'info', labelKey: 'taskCenter.syncing' },
}

/**
 * 任务中心：把同步任务状态推送到右上角通知栈（复用 Toast 组件，不单独渲染卡片）。
 * 运行中 = 持久任务卡（进度条 + 停止操作，同 key 更新）；结束 = 普通结果通知自动消失。
 * 历史任务（应用重启恢复）不重复弹结果（deriveTaskCenterState 内部按 seen 过滤）。
 * 本组件不渲染 DOM；须挂载在 ToastHost 之后（effects 自下而上，保证先订阅后推送）。
 */
export default function TaskCenter({ tasks }: { tasks: SyncTaskRecord[] }) {
  const { t } = useI18n()
  const seenRef = useRef<Set<string>>(new Set())
  const activeRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const dismissedRef = useRef<Set<string>>(new Set())
  /** 当前已展示的持久任务卡 key 集合（任务消失时关闭） */
  const shownCardsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const derived = deriveTaskCenterState(
      tasks,
      seenRef.current,
      activeRef.current,
      dismissedRef.current,
      initializedRef.current,
    )
    seenRef.current = derived.seen
    activeRef.current = derived.active
    initializedRef.current = derived.initialized

    // 结束任务：关闭对应持久卡，弹普通结果通知（失败附原因）
    for (const item of derived.finished) {
      closeTaskToast(`task-${item.id}`)
      const meta = FINISHED_TOAST[item.status]
      const failed = item.status === 'failed' || item.status === 'interrupted'
      notify(
        meta.type,
        item.name,
        failed && item.reason
          ? userFacingErrorMessage(item.reason, t(meta.labelKey))
          : t(meta.labelKey),
      )
    }

    // 运行中任务卡同步（同 key 更新进度；超出上限只显示汇总）
    const nextKeys = new Set<string>()
    const running = derived.running
    if (running.length > MAX_RUNNING) {
      nextKeys.add('task-summary')
      notifyTask('task-summary', {
        title: t('taskCenter.runningCount', { count: running.length }),
      })
    } else {
      for (const item of running) {
        const key = `task-${item.id}`
        nextKeys.add(key)
        notifyTask(key, {
          title: item.name,
          progress: item.progress,
          progressLabel: `${t('taskCenter.syncing')} ${Math.round(item.progress * 100)}%`,
          action: {
            label: t('syncHistory.stopTask'),
            onClick: () => {
              void window.electronAPI.platforms.stopSync(item.id)
            },
          },
        })
      }
    }
    // 关闭不再展示的旧卡片（任务消失/汇总切换）
    for (const key of shownCardsRef.current) {
      if (!nextKeys.has(key)) closeTaskToast(key)
    }
    shownCardsRef.current = nextKeys
  }, [tasks, t])

  return null
}
