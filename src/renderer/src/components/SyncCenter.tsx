import { useState } from 'react'
import type { PlatformMeta, PlatformSong } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import type { SyncItemResult, SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import { useI18n } from '../i18n'
import type { TranslationKey, TranslateParams } from '../i18n/translations'
import { syncItemTitle } from '../sync/helpers'
import SongList from './SongList'
import ProgressBar from './ProgressBar'

const log = createRendererLogger('renderer.sync-center')

type Translate = (key: TranslationKey, params?: TranslateParams) => string

interface SyncCenterProps {
  platforms: PlatformMeta[]
  tasks: SyncTaskRecord[]
  onNewTask: () => void
  onTaskRemove: (id: string) => void
  onClearAll: () => void
  /** 待用户手动选择的歌曲数（>0 时显示「去确认」入口） */
  pendingChoicesCount: number
  onGoConfirm: () => void
  /** 可手动介入（停止/跳过）的任务 id：执行中且不在等待确认阶段 */
  intervenableIds: string[]
  onStopTask: (id: string) => void
  onSkipTask: (id: string) => void
}

/** 任务状态元数据：图标 / 颜色 / 文案键 一处定义 */
const STATUS_META: Record<SyncTaskStatus, { icon: string; color: string; labelKey: TranslationKey }> = {
  running: { icon: 'progress_activity', color: 'text-tertiary', labelKey: 'syncCenter.statusRunning' },
  done: { icon: 'check_circle', color: 'text-primary', labelKey: 'syncCenter.statusDone' },
  interrupted: { icon: 'pause_circle', color: 'text-secondary', labelKey: 'syncCenter.statusInterrupted' },
  stopped: { icon: 'stop_circle', color: 'text-secondary', labelKey: 'syncCenter.statusStopped' },
  failed: { icon: 'error_outline', color: 'text-error', labelKey: 'syncCenter.statusFailed' },
}

/** 失败/跳过项的原因文案（稳定 reason 码翻译，平台原始错误透传） */
function failedReasonText(t: Translate, item: SyncItemResult): string {
  const title = syncItemTitle(item.query)
  switch (item.reason) {
    case 'no-match':
      return t('sync.failedNoMatch', { title })
    case 'unresolved':
      return t('sync.failedUnresolved', { title })
    case 'rate-limited':
      return t('sync.failedRateLimited')
    case 'skipped':
      return t('syncCenter.itemSkipped')
    default:
      return item.message ?? t('sync.failedGeneric')
  }
}

/** 明细项在模板中的稳定 id（组内唯一） */
function itemId(item: SyncItemResult): string {
  return `${item.status}-${item.index}-${item.songId ?? ''}`
}

/** 同步明细 → 模板所需的 PlatformSong 视图（明细无封面，其余字段按 query 透传） */
function toSong(item: SyncItemResult): PlatformSong {
  return {
    id: itemId(item),
    title: item.query.title,
    artist: item.query.artist ?? '',
    album: item.query.album,
    durationMs: item.query.durationMs,
  }
}

/** 任务介入按钮组（跳过/停止），卡片头部与详情区共用 */
function InterveneButtons({
  onStop,
  onSkip,
  size = 'sm',
}: {
  onStop: () => void
  onSkip: () => void
  size?: 'sm' | 'md'
}) {
  const { t } = useI18n()
  const md = size === 'md'
  const buttonCls = md
    ? 'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-label-md text-label-md transition-colors'
    : 'flex items-center gap-1 rounded-md border px-2 py-1 font-label-sm text-label-sm transition-colors'
  const iconCls = md ? 'text-base' : 'text-sm'
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onSkip()
        }}
        className={`${buttonCls} border-secondary text-secondary hover:bg-secondary/10`}
      >
        <span className={`material-symbols-outlined ${iconCls}`}>skip_next</span>
        {t('syncCenter.skipCurrent')}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onStop()
        }}
        className={`${buttonCls} border-error text-error hover:bg-error/10`}
      >
        <span className={`material-symbols-outlined ${iconCls}`}>stop</span>
        {t('syncCenter.stopTask')}
      </button>
    </>
  )
}

/** 行内展开的详情清单：分组展示成功/待选择/失败，运行中任务可介入 */
function TaskDetailSection({
  task,
  intervenable,
  onStop,
  onSkip,
}: {
  task: SyncTaskRecord
  intervenable: boolean
  onStop: () => void
  onSkip: () => void
}) {
  const { t } = useI18n()
  const matched = task.detail.filter((i) => i.status === 'matched')
  const choices = task.detail.filter((i) => i.status === 'choice')
  const failedItems = task.detail.filter((i) => i.status === 'failed' || i.status === 'skipped')
  const failedMeta = new Map(
    failedItems.map((item) => [
      itemId(item),
      { text: failedReasonText(t, item), skipped: item.status === 'skipped' },
    ]),
  )

  return (
    <div className="mt-3 border-t border-outline-variant pt-3">
      {task.detail.length === 0 ? (
        task.failedDetail.length > 0 ? (
          <ul className="space-y-1 font-label-sm text-label-sm text-error">
            {task.failedDetail.map((f, i) => (
              <li key={i}>· {f}</li>
            ))}
          </ul>
        ) : (
          <p className="font-label-sm text-label-sm text-outline">
            {t('syncCenter.detailEmpty')}
          </p>
        )
      ) : (
        <div className="max-h-96 space-y-3 overflow-y-auto">
          {matched.length > 0 && (
            <section>
              <p className="flex items-center gap-1.5 font-label-sm text-label-sm font-medium text-primary">
                <span className="material-symbols-outlined text-sm">check_circle</span>
                {t('syncCenter.matchedSection', { count: matched.length })}
              </p>
              <SongList
                songs={matched.map(toSong)}
                showIndex={false}
                showCover={false}
                className="mt-1"
              />
            </section>
          )}

          {choices.length > 0 && (
            <section>
              <p className="flex items-center gap-1.5 font-label-sm text-label-sm font-medium text-tertiary">
                <span className="material-symbols-outlined text-sm">help</span>
                {t('syncCenter.choiceSection', { count: choices.length })}
              </p>
              <SongList
                songs={choices.map(toSong)}
                showIndex={false}
                showCover={false}
                className="mt-1"
              />
            </section>
          )}

          {failedItems.length > 0 && (
            <section>
              <p className="flex items-center gap-1.5 font-label-sm text-label-sm font-medium text-error">
                <span className="material-symbols-outlined text-sm">error_outline</span>
                {t('syncCenter.failedSection', { count: failedItems.length })}
              </p>
              <SongList
                songs={failedItems.map(toSong)}
                showIndex={false}
                showCover={false}
                className="mt-1"
                renderSubtitle={(s) => {
                  const meta = failedMeta.get(s.id)
                  if (!meta) return null
                  return (
                    <span className={meta.skipped ? 'text-secondary' : 'text-error'}>
                      {meta.text}
                    </span>
                  )
                }}
                renderAction={(s) => {
                  const meta = failedMeta.get(s.id)
                  if (!meta) return null
                  return (
                    <span
                      className={`material-symbols-outlined text-sm ${
                        meta.skipped ? 'text-secondary' : 'text-error'
                      }`}
                    >
                      {meta.skipped ? 'skip_next' : 'error_outline'}
                    </span>
                  )
                }}
              />
            </section>
          )}

          {intervenable && (
            <div className="pt-1">
              <p className="font-label-sm text-label-sm text-on-surface-variant">
                {t('syncCenter.stuckHint')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <InterveneButtons size="md" onStop={onStop} onSkip={onSkip} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SyncCenter({
  platforms,
  tasks,
  onNewTask,
  onTaskRemove,
  onClearAll,
  pendingChoicesCount,
  onGoConfirm,
  intervenableIds,
  onStopTask,
  onSkipTask,
}: SyncCenterProps) {
  const { t } = useI18n()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const running = tasks.filter((task) => task.status === 'running').length
  const done = tasks.filter((task) => task.status === 'done').length
  const failed = tasks.filter((task) => task.status === 'failed').length
  const interrupted = tasks.filter((task) => task.status === 'interrupted').length
  const stopped = tasks.filter((task) => task.status === 'stopped').length

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
        {stopped > 0 && (
          <span>
            {t('syncCenter.statusStopped')}{' '}
            <span className="font-medium text-secondary">{stopped}</span>
          </span>
        )}
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

        {tasks.map((task) => {
          const expanded = expandedId === task.id
          const intervenable = intervenableIds.includes(task.id)
          const statusMeta = STATUS_META[task.status]
          return (
            <div
              key={task.id}
              onClick={() => {
                log.debug('sync.toggle-detail', '展开/收起任务详情', { taskId: task.id })
                setExpandedId(expanded ? null : task.id)
              }}
              className="cursor-pointer rounded-lg border border-outline-variant bg-surface-container-low p-4 transition-colors hover:border-outline"
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`material-symbols-outlined text-base ${statusMeta.color} ${
                      task.status === 'running' ? 'animate-spin' : ''
                    }`}
                  >
                    {statusMeta.icon}
                  </span>
                  <p className="truncate font-body-md text-body-md font-medium">{task.name}</p>
                  <span className="rounded-full bg-surface-container-highest px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                    {t(statusMeta.labelKey)}
                  </span>
                  <span className="material-symbols-outlined text-sm text-outline">
                    {expanded ? 'expand_less' : 'expand_more'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {intervenable && (
                    <InterveneButtons
                      onStop={() => onStopTask(task.id)}
                      onSkip={() => onSkipTask(task.id)}
                    />
                  )}
                  <span className="font-label-mono text-label-mono text-outline">
                    {task.createdAt}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
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
                  {task.source === 'text-import'
                    ? t('syncCenter.sourceTextImport')
                    : task.source === 'playlist-import'
                      ? t('syncCenter.sourcePlaylistImport')
                      : task.source}
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
                {(task.status === 'done' || task.status === 'failed' || task.status === 'stopped') && (
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
                <div className="mt-3">
                  <ProgressBar ratio={task.progress} />
                </div>
              )}

              {expanded && (
                <TaskDetailSection
                  task={task}
                  intervenable={intervenable}
                  onStop={() => onStopTask(task.id)}
                  onSkip={() => onSkipTask(task.id)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
