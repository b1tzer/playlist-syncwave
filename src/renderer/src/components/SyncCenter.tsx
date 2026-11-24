import { useState } from 'react'
import type { PlatformMeta } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import type { SyncTaskRecord } from '@core/models/sync'
import { useI18n } from '../i18n'

const log = createRendererLogger('renderer.sync-center')

interface SyncCenterProps {
  platforms: PlatformMeta[]
  tasks: SyncTaskRecord[]
  onNewTask: () => void
  onTaskRemove: (id: string) => void
  onClearAll: () => void
  /** 待用户手动选择的歌曲数（>0 时显示「去确认」入口） */
  pendingChoicesCount: number
  onGoConfirm: () => void
}

export default function SyncCenter({
  platforms,
  tasks,
  onNewTask,
  onTaskRemove,
  onClearAll,
  pendingChoicesCount,
  onGoConfirm,
}: SyncCenterProps) {
  const { t } = useI18n()
  const running = tasks.filter((task) => task.status === 'running').length
  const done = tasks.filter((task) => task.status === 'done').length
  const failed = tasks.filter((task) => task.status === 'failed').length
  const interrupted = tasks.filter((task) => task.status === 'interrupted').length

  const handleNewTask = () => {
    log.info('sync.new-task', '新建同步任务')
    onNewTask()
  }

  const [clearConfirm, setClearConfirm] = useState(false)

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">
            {t('syncCenter.title')}
          </h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            {t('syncCenter.subtitle')}
          </p>
        </div>
        <button
          onClick={handleNewTask}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85"
        >
          <span className="material-symbols-outlined text-base">add</span>
          {t('syncCenter.newTask')}
          <span className="font-label-mono text-label-mono opacity-70">⌘N</span>
        </button>
      </div>

      <div className="mt-6 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
        <span className="material-symbols-outlined text-base">terminal</span>
        <span>{t('syncCenter.logTitle')}</span>
        <span className="mx-2 h-3 w-px bg-outline-variant" />
        <span>
          {t('syncCenter.allTasks')}{' '}
          <span className="font-medium text-on-surface">{tasks.length}</span>
        </span>
        <span>
          {t('syncCenter.running')} <span className="font-medium text-tertiary">{running}</span>
        </span>
        <span>
          {t('syncCenter.done')} <span className="font-medium text-primary">{done}</span>
        </span>
        <span>
          {t('syncCenter.interrupted')}{' '}
          <span className="font-medium text-secondary">{interrupted}</span>
        </span>
        <span>
          {t('syncCenter.failed')} <span className="font-medium text-error">{failed}</span>
        </span>
        {pendingChoicesCount > 0 && (
          <button
            onClick={() => {
              log.info('sync.go-confirm', '前往确认待选歌曲', { count: pendingChoicesCount })
              onGoConfirm()
            }}
            className="flex items-center gap-1 rounded-full border border-tertiary px-2.5 py-0.5 font-label-sm text-label-sm text-tertiary transition-colors hover:bg-tertiary/10"
          >
            <span className="material-symbols-outlined text-sm">fact_check</span>
            {t('syncCenter.awaitingConfirm', { count: pendingChoicesCount })} ·{' '}
            {t('syncCenter.goConfirm')}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 font-label-mono text-label-mono text-outline">
          <span className="material-symbols-outlined text-sm">database</span>
          {tasks.length > 0 && (
            <button
              onClick={() => {
                if (clearConfirm) {
                  log.info('sync.clear-all', '确认清空同步历史', { count: tasks.length })
                  onClearAll()
                  setClearConfirm(false)
                } else {
                  setClearConfirm(true)
                }
              }}
              className={`rounded-md px-2 py-0.5 transition-colors ${
                clearConfirm
                  ? 'bg-error/10 text-error hover:bg-error/15'
                  : 'hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              {clearConfirm ? t('syncCenter.clearAllConfirm') : t('syncCenter.clearAll')}
            </button>
          )}
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {tasks.length === 0 && (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-6 py-14 text-center">
            <span className="material-symbols-outlined text-5xl text-outline">sync_alt</span>
            <p className="mt-3 font-body-md text-body-md text-on-surface-variant">
              {t('syncCenter.empty')}
            </p>
            <p className="mt-1 font-label-sm text-label-sm text-outline">
              {t('syncCenter.emptyHint')}
            </p>
            <button
              onClick={handleNewTask}
              className="mt-4 flex items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-md text-label-md text-primary transition-colors hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-base">add</span>
              {t('syncCenter.firstTask')}
            </button>
          </div>
        )}

        {tasks.map((task) => (
          <div
            key={task.id}
            className="rounded-lg border border-outline-variant bg-surface-container-low p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {task.status === 'running' && (
                  <span className="material-symbols-outlined animate-spin text-base text-tertiary">
                    progress_activity
                  </span>
                )}
                {task.status === 'done' && (
                  <span className="material-symbols-outlined text-base text-primary">
                    check_circle
                  </span>
                )}
                {task.status === 'interrupted' && (
                  <span className="material-symbols-outlined text-base text-secondary">
                    pause_circle
                  </span>
                )}
                {task.status === 'failed' && (
                  <span className="material-symbols-outlined text-base text-error">
                    error_outline
                  </span>
                )}
                <p className="font-body-md text-body-md font-medium">{task.name}</p>
                <span className="rounded-full bg-surface-container-highest px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                  {task.status === 'running'
                    ? t('syncCenter.statusRunning')
                    : task.status === 'done'
                      ? t('syncCenter.statusDone')
                      : task.status === 'interrupted'
                        ? t('syncCenter.statusInterrupted')
                        : t('syncCenter.statusFailed')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-label-mono text-label-mono text-outline">
                  {task.createdAt}
                </span>
                <button
                  onClick={() => {
                    log.info('sync.remove-task', '删除同步任务', { taskId: task.id })
                    onTaskRemove(task.id)
                  }}
                  disabled={task.status === 'running'}
                  title={t('syncCenter.removeTask')}
                  className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-base">delete</span>
                </button>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">description</span>
                {task.source === 'text-import' ? t('syncCenter.sourceTextImport') : task.source}
              </span>
              <span className="material-symbols-outlined text-sm text-outline">arrow_forward</span>
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">library_music</span>
                {platforms.find((p) => p.id === task.targetPlatform)?.name ?? task.targetPlatform}
              </span>
              {task.status === 'running' && (
                <span className="ml-auto flex items-center gap-1 text-tertiary">
                  <span className="material-symbols-outlined text-sm">refresh</span>
                  {t('syncCenter.matchingProgress', {
                    current: Math.round(task.progress * task.total),
                    total: task.total,
                  })}
                </span>
              )}
              {(task.status === 'done' || task.status === 'failed') && (
                <span className="ml-auto">
                  {t('syncCenter.success')} <span className="text-primary">{task.added}</span>
                  {task.failed > 0 && (
                    <>
                      {' '}
                      {t('syncCenter.failedCount')}{' '}
                      <span className="text-error">{task.failed}</span>
                    </>
                  )}
                </span>
              )}
            </div>

            {task.status === 'running' && (
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.round(task.progress * 100)}%` }}
                />
              </div>
            )}

            {(task.status === 'failed' || task.status === 'interrupted') &&
              task.failedDetail.length > 0 && (
                <ul className="mt-3 max-h-24 space-y-1 overflow-y-auto font-label-sm text-label-sm text-error">
                  {task.failedDetail.map((f, i) => (
                    <li key={i}>· {f}</li>
                  ))}
                </ul>
              )}
          </div>
        ))}
      </div>
    </div>
  )
}
