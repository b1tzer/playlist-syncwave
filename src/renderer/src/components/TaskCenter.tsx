import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformMeta } from '@core/models/platform'
import type { SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import {
  deriveTaskCenterState,
  type TaskCenterFinishedItem,
  type TaskCenterRunningItem,
} from '@core/sync/taskCenter'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/translations'
import { userFacingErrorMessage } from '../utils/ipcError'
import PlatformLogo from './PlatformLogo'
import ProgressBar from './ProgressBar'

/** 结束结果卡片展示时长：用户可手动关闭 */
const FINISHED_VISIBLE_MS = 8000
/** 同屏最多展示的结果卡片数 */
const MAX_FINISHED = 3
/** 同屏最多展示的运行中任务数（超出仅显示汇总） */
const MAX_RUNNING = 3

const FINISHED_META: Record<
  SyncTaskStatus,
  { icon: string; color: string; labelKey: TranslationKey }
> = {
  done: {
    icon: 'check_circle',
    color: 'text-primary',
    labelKey: 'taskCenter.done',
  },
  failed: { icon: 'error', color: 'text-error', labelKey: 'taskCenter.failed' },
  stopped: {
    icon: 'stop_circle',
    color: 'text-secondary',
    labelKey: 'taskCenter.stopped',
  },
  interrupted: {
    icon: 'pause_circle',
    color: 'text-secondary',
    labelKey: 'taskCenter.interrupted',
  },
  running: {
    icon: 'progress_activity',
    color: 'text-tertiary',
    labelKey: 'taskCenter.syncing',
  },
}

function RunningCard({
  item,
  platforms,
  onStop,
}: {
  item: TaskCenterRunningItem
  platforms: PlatformMeta[]
  onStop: (id: string) => void
}) {
  const { t } = useI18n()
  const target = platforms.find((p) => p.id === item.targetPlatform)
  const percent = Math.round(item.progress * 100)
  return (
    <div
      data-testid="task-center-running"
      className="[-webkit-app-region:no-drag] w-56 rounded-lg border border-outline-variant bg-surface-container px-3 py-2 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-sm text-tertiary animate-spin">
          progress_activity
        </span>
        <span className="min-w-0 flex-1 truncate font-label-md text-label-md text-on-surface">
          {item.name}
        </span>
        <PlatformLogo
          platform={item.targetPlatform}
          name={target?.name ?? item.targetPlatform}
          icon={target?.icon ?? 'cloud'}
          size="h-4 w-4"
          iconSize="text-sm"
        />
        <button
          type="button"
          onClick={() => onStop(item.id)}
          title={t('syncHistory.stopTask')}
          aria-label={t('syncHistory.stopTask')}
          className="flex items-center rounded-md p-0.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
        >
          <span className="material-symbols-outlined text-sm">stop</span>
        </button>
      </div>
      <div className="mt-2">
        <ProgressBar ratio={item.progress} label={`${t('taskCenter.syncing')} ${percent}%`} />
      </div>
    </div>
  )
}

function FinishedCard({
  item,
  platforms,
  onDismiss,
}: {
  item: TaskCenterFinishedItem
  platforms: PlatformMeta[]
  onDismiss: (id: string) => void
}) {
  const { t } = useI18n()
  const meta = FINISHED_META[item.status]
  const target = platforms.find((p) => p.id === item.targetPlatform)
  const failed = item.status === 'failed' || item.status === 'interrupted'
  // 每张结果卡独立计时自动消失：不受其他任务进度更新（父组件频繁重渲）影响
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), FINISHED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [item.id, onDismiss])
  return (
    <div
      data-testid="task-center-finished"
      data-status={item.status}
      className="[-webkit-app-region:no-drag] w-56 rounded-lg border border-outline-variant bg-surface-container px-3 py-2 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span className={`material-symbols-outlined text-sm ${meta.color}`}>{meta.icon}</span>
        <span className="min-w-0 flex-1 truncate font-label-md text-label-md text-on-surface">
          {item.name}
        </span>
        <PlatformLogo
          platform={item.targetPlatform}
          name={target?.name ?? item.targetPlatform}
          icon={target?.icon ?? 'cloud'}
          size="h-4 w-4"
          iconSize="text-sm"
        />
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          title={t('taskCenter.close')}
          aria-label={t('taskCenter.close')}
          className="flex items-center rounded-md p-0.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
      <p
        className={`mt-1 break-words font-label-sm text-label-sm ${
          failed ? 'text-error' : 'text-on-surface-variant'
        }`}
      >
        {failed && item.reason
          ? userFacingErrorMessage(item.reason, t(meta.labelKey))
          : t(meta.labelKey)}
      </p>
    </div>
  )
}

/**
 * 右上角任务中心：创建同步任务后展示任务名与进度条；
 * 结束后展示成功/失败（失败附原因），可手动关闭，数秒后自动消失。
 * 历史任务（应用重启恢复）不会重复弹出结果。
 */
export default function TaskCenter({
  tasks,
  platforms,
}: {
  tasks: SyncTaskRecord[]
  platforms: PlatformMeta[]
}) {
  const { t } = useI18n()
  const seenRef = useRef<Set<string>>(new Set())
  const activeRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const dismissedRef = useRef<Set<string>>(new Set())
  const [running, setRunning] = useState<TaskCenterRunningItem[]>([])
  const [finished, setFinished] = useState<TaskCenterFinishedItem[]>([])

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
    setRunning(derived.running)
    if (derived.finished.length > 0) {
      setFinished((prev) => [...derived.finished, ...prev].slice(0, MAX_FINISHED))
    }
  }, [tasks])

  const dismiss = useCallback((id: string) => {
    dismissedRef.current = new Set(dismissedRef.current).add(id)
    setFinished((prev) => prev.filter((x) => x.id !== id))
  }, [])

  if (running.length === 0 && finished.length === 0) return null

  return (
    <div className="ml-auto flex items-center gap-2">
      {running.length > MAX_RUNNING ? (
        <span className="[-webkit-app-region:no-drag] flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 py-1.5 font-label-sm text-label-sm text-on-surface-variant">
          <span className="material-symbols-outlined text-sm text-tertiary">progress_activity</span>
          {t('taskCenter.runningCount', { count: running.length })}
        </span>
      ) : (
        running.map((item) => (
          <RunningCard
            key={item.id}
            item={item}
            platforms={platforms}
            onStop={(id) => {
              void window.electronAPI.platforms.stopSync(id)
            }}
          />
        ))
      )}
      {finished.map((item) => (
        <FinishedCard key={item.id} item={item} platforms={platforms} onDismiss={dismiss} />
      ))}
    </div>
  )
}
