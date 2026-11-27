import { useMemo, useState } from 'react'
import type { PlatformMeta, PlatformSong } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import type { SyncItemResult, SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import { useI18n } from '../i18n'
import type { TranslationKey, TranslateParams } from '../i18n/translations'
import { syncItemTitle } from '../sync/helpers'
import { syncSourceLabel, isLocalSource, sourcePlatformId } from '../sync/sourceLabel'
import { userFacingErrorMessage } from '../utils/ipcError'
import { deriveTaskCounts, firstFailureReason, taskSummaryKind } from '@core/sync/taskStats'
import SongList from './SongList'
import PlatformLogo from './PlatformLogo'
import ProgressBar from './ProgressBar'
import LoadMoreSentinel from './LoadMoreSentinel'

const log = createRendererLogger('renderer.sync-history')

/** 任务列表滚动分页：首屏渲染条数 */
const TASK_PAGE_SIZE = 200

type Translate = (key: TranslationKey, params?: TranslateParams) => string

/** 除成功外的结束态：允许重新执行（复用上次已匹配数据） */
const RETRYABLE_STATUSES: SyncTaskStatus[] = ['failed', 'interrupted', 'stopped']

interface SyncHistoryProps {
  platforms: PlatformMeta[]
  tasks: SyncTaskRecord[]
  onNewTask: () => void
  onTaskRemove: (id: string) => void
  onClearAll: () => void
  /** 待用户手动选择的歌曲数（>0 时显示「去确认」入口） */
  pendingChoicesCount: number
  onGoConfirm: () => void
  /** 可手动介入（停止）的任务 id：执行中且不在等待确认阶段 */
  intervenableIds: string[]
  onStopTask: (id: string) => void
  /** 重新执行未成功的任务：复用原始输入与已匹配结果 */
  onRetryTask: (task: SyncTaskRecord) => void
}

/**
 * 任务时间显示：优先按精确时间戳（绝对时间）实时格式化——
 * OS 修改时区后所有任务自动按新时区换算展示，不会留下旧时区的时间快照；
 * 历史任务缺失时间戳时回退展示存储的可读时间字符串。
 */
function taskTimeText(task: SyncTaskRecord, formatDateTime: (date: Date) => string): string {
  if (task.createdAtMs && task.createdAtMs > 0) return formatDateTime(new Date(task.createdAtMs))
  return task.createdAt
}

/** 任务状态元数据：图标 / 颜色 / 文案键 一处定义 */
const STATUS_META: Record<SyncTaskStatus, { icon: string; color: string; labelKey: TranslationKey }> = {
  running: { icon: 'progress_activity', color: 'text-tertiary', labelKey: 'syncHistory.statusRunning' },
  done: { icon: 'check_circle', color: 'text-primary', labelKey: 'syncHistory.statusDone' },
  interrupted: { icon: 'pause_circle', color: 'text-secondary', labelKey: 'syncHistory.statusInterrupted' },
  stopped: { icon: 'stop_circle', color: 'text-secondary', labelKey: 'syncHistory.statusStopped' },
  failed: { icon: 'error_outline', color: 'text-error', labelKey: 'syncHistory.statusFailed' },
}

/** 统计项筛选按钮：多选状态下高亮，点击切换 */
function FilterChip({
  label,
  count,
  countClass,
  active,
  onClick,
  title,
}: {
  label: string
  count: number
  countClass: string
  active: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 transition-colors ${
        active
          ? 'bg-surface-container-high font-medium text-on-surface'
          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
      }`}
    >
      {label} <span className={`font-medium ${countClass}`}>{count}</span>
    </button>
  )
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
      return t('syncHistory.itemSkipped')
    default:
      // 展示处兜底：历史任务明细可能存有旧版原始错误，统一过滤技术性报错
      return userFacingErrorMessage(item.message ?? '', t('sync.failedGeneric'))
  }
}

/**
 * 失败原因行的展示兜底：技术性报错过滤为通用文案；
 * 「歌名（原因）」格式行在原因不可展示时保留歌名部分，不丢上下文。
 */
function failedDetailLine(t: Translate, line: string): string {
  const friendly = userFacingErrorMessage(line, '')
  if (friendly) return friendly
  const idx = line.indexOf('（')
  return idx > 0 ? line.slice(0, idx) : t('sync.failedGeneric')
}

/** 明细项在模板中的稳定 id（组内唯一） */
function itemId(item: SyncItemResult): string {
  return `${item.status}-${item.index}-${item.songId ?? ''}`
}

/**
 * 同步明细 → 模板所需的 PlatformSong 视图（明细无封面）。
 * 已匹配项优先展示目标平台资源的真实关键信息（供后续直接使用），缺失时按 query 透传。
 */
function toSong(item: SyncItemResult): PlatformSong {
  const target = item.matchedSong
  return {
    id: itemId(item),
    title: target?.title ?? item.query.title,
    artist: target?.artist ?? item.query.artist ?? '',
    album: target?.album ?? item.query.album,
    durationMs: item.query.durationMs,
  }
}

/** 任务停止按钮（卡片头部与详情区共用） */
function StopTaskButton({ onStop, size = 'sm' }: { onStop: () => void; size?: 'sm' | 'md' }) {
  const { t } = useI18n()
  const md = size === 'md'
  const buttonCls = md
    ? 'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-label-md text-label-md transition-colors'
    : 'flex items-center gap-1 rounded-md border px-2 py-1 font-label-sm text-label-sm transition-colors'
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onStop()
      }}
      className={`${buttonCls} border-error text-error hover:bg-error/10`}
    >
      <span className="material-symbols-outlined text-sm">stop</span>
      {t('syncHistory.stopTask')}
    </button>
  )
}

/** 行内展开的详情清单：分组展示成功/待选择/失败，运行中任务可停止 */
function TaskDetailSection({
  task,
  intervenable,
  onStop,
}: {
  task: SyncTaskRecord
  intervenable: boolean
  onStop: () => void
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
              <li key={i}>· {failedDetailLine(t, f)}</li>
            ))}
          </ul>
        ) : (
          <p className="font-label-sm text-label-sm text-outline">
            {t('syncHistory.detailEmpty')}
          </p>
        )
      ) : (
        <div>
          {(task.status === 'failed' || task.status === 'interrupted') &&
            task.failedDetail.length > 0 && (
              <ul className="mb-3 space-y-1 font-label-sm text-label-sm text-error">
                {task.failedDetail.map((f, i) => (
                  <li key={i}>· {failedDetailLine(t, f)}</li>
                ))}
              </ul>
            )}
          <div className="max-h-96 space-y-3 overflow-y-auto">
          {matched.length > 0 && (
            <section>
              <p className="flex items-center gap-1.5 font-label-sm text-label-sm font-medium text-primary">
                <span className="material-symbols-outlined text-sm">check_circle</span>
                {t('syncHistory.matchedSection', { count: matched.length })}
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
                {t('syncHistory.choiceSection', { count: choices.length })}
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
                {t('syncHistory.failedSection', { count: failedItems.length })}
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
                {t('syncHistory.stuckHint')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <StopTaskButton size="md" onStop={onStop} />
              </div>
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function SyncHistory({
  platforms,
  tasks,
  onNewTask,
  onTaskRemove,
  onClearAll,
  pendingChoicesCount,
  onGoConfirm,
  intervenableIds,
  onStopTask,
  onRetryTask,
}: SyncHistoryProps) {
  const { t, formatDateTime } = useI18n()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 滚动分页：只渲染已加载部分，哨兵触发时追加下一页
  const [visibleCount, setVisibleCount] = useState(TASK_PAGE_SIZE)
  /** 任务列表排序：默认最新优先（按创建时间），可切换为最早优先 */
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  /** 状态多选筛选：空集合表示默认「全部任务」 */
  const [statusFilter, setStatusFilter] = useState<SyncTaskStatus[]>([])
  const filteredTasks = useMemo(
    () =>
      statusFilter.length === 0
        ? tasks
        : tasks.filter((task) => statusFilter.includes(task.status)),
    [tasks, statusFilter],
  )
  const toggleStatusFilter = (status: SyncTaskStatus) => {
    setStatusFilter((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    )
  }
  const sortedTasks = useMemo(() => {
    const sorted = [...filteredTasks]
    sorted.sort((a, b) => {
      const am = a.createdAtMs ?? 0
      const bm = b.createdAtMs ?? 0
      if (am !== bm) return sortOrder === 'newest' ? bm - am : am - bm
      // 精确时间戳缺失的历史任务：以可读时间字符串兜底
      return sortOrder === 'newest'
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt)
    })
    return sorted
  }, [filteredTasks, sortOrder])
  const visibleTasks = sortedTasks.slice(0, visibleCount)
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
            {t('syncHistory.title')}
          </h1>
        </div>
        <button
          onClick={handleNewTask}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85"
        >
          <span className="material-symbols-outlined text-sm">add</span>
          {t('syncHistory.newTask')}
        </button>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
        <span className="material-symbols-outlined text-sm">terminal</span>
        <span>{t('syncHistory.logTitle')}</span>
        <span className="mx-2 h-3 w-px bg-outline-variant" />
        <FilterChip
          label={t('syncHistory.allTasks')}
          count={tasks.length}
          countClass="text-on-surface"
          active={statusFilter.length === 0}
          onClick={() => setStatusFilter([])}
          title={t('syncHistory.filterHint')}
        />
        <FilterChip
          label={t('syncHistory.running')}
          count={running}
          countClass="text-tertiary"
          active={statusFilter.includes('running')}
          onClick={() => toggleStatusFilter('running')}
        />
        <FilterChip
          label={t('syncHistory.done')}
          count={done}
          countClass="text-primary"
          active={statusFilter.includes('done')}
          onClick={() => toggleStatusFilter('done')}
        />
        <FilterChip
          label={t('syncHistory.interrupted')}
          count={interrupted}
          countClass="text-secondary"
          active={statusFilter.includes('interrupted')}
          onClick={() => toggleStatusFilter('interrupted')}
        />
        {(stopped > 0 || statusFilter.includes('stopped')) && (
          <FilterChip
            label={t('syncHistory.statusStopped')}
            count={stopped}
            countClass="text-secondary"
            active={statusFilter.includes('stopped')}
            onClick={() => toggleStatusFilter('stopped')}
          />
        )}
        <FilterChip
          label={t('syncHistory.failed')}
          count={failed}
          countClass="text-error"
          active={statusFilter.includes('failed')}
          onClick={() => toggleStatusFilter('failed')}
        />
        {pendingChoicesCount > 0 && (
          <button
            onClick={() => {
              log.info('sync.go-confirm', '前往确认待选歌曲', { count: pendingChoicesCount })
              onGoConfirm()
            }}
            className="flex items-center gap-1 rounded-full border border-tertiary px-2.5 py-0.5 font-label-sm text-label-sm text-tertiary transition-colors hover:bg-tertiary/10"
          >
            <span className="material-symbols-outlined text-sm">fact_check</span>
            {t('syncHistory.awaitingConfirm', { count: pendingChoicesCount })} ·{' '}
            {t('syncHistory.goConfirm')}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 font-label-mono text-label-mono text-outline">
          {tasks.length > 0 && (
            <button
              onClick={() => {
                const next = sortOrder === 'newest' ? 'oldest' : 'newest'
                log.info('sync.sort-toggle', '切换任务排序', { order: next })
                setSortOrder(next)
              }}
              title={t('syncHistory.sortHint')}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 transition-colors hover:bg-surface-container-high hover:text-on-surface"
            >
              <span className="material-symbols-outlined text-sm">
                {sortOrder === 'newest' ? 'south' : 'north'}
              </span>
              {sortOrder === 'newest' ? t('syncHistory.sortNewest') : t('syncHistory.sortOldest')}
            </button>
          )}
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
              {clearConfirm ? t('syncHistory.clearAllConfirm') : t('syncHistory.clearAll')}
            </button>
          )}
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {sortedTasks.length === 0 && (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-6 py-14 text-center">
            <span className="material-symbols-outlined text-5xl text-outline">sync_alt</span>
            <p className="mt-3 font-body-md text-body-md text-on-surface-variant">
              {tasks.length === 0 ? t('syncHistory.empty') : t('syncHistory.filterEmpty')}
            </p>
            <p className="mt-1 font-label-sm text-label-sm text-outline">
              {tasks.length === 0 ? t('syncHistory.emptyHint') : t('syncHistory.filterEmptyHint')}
            </p>
            <button
              onClick={tasks.length === 0 ? handleNewTask : () => setStatusFilter([])}
              className="mt-4 flex items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-md text-label-md text-primary transition-colors hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-sm">
                {tasks.length === 0 ? 'add' : 'filter_alt_off'}
              </span>
              {tasks.length === 0 ? t('syncHistory.firstTask') : t('syncHistory.allTasks')}
            </button>
          </div>
        )}

        {visibleTasks.map((task, i) => {
          const expanded = expandedId === task.id
          const intervenable = intervenableIds.includes(task.id)
          const statusMeta = STATUS_META[task.status]
          const target = platforms.find((p) => p.id === task.targetPlatform)
          // 平台歌单导入携带来源平台 id：行内展示「A 平台 → B 平台」而非笼统的「歌单导入」
          const sourcePlatform = sourcePlatformId(task.source)
          const sourceMeta = sourcePlatform
            ? platforms.find((p) => p.id === sourcePlatform)
            : null
          // 行摘要计数以逐首明细为权威口径（空明细回退标量），与展开详情保持一致
          const counts = deriveTaskCounts(task.detail, { added: task.added, failed: task.failed })
          return (
            <div
              key={task.id}
              onClick={() => {
                log.debug('sync.toggle-detail', '展开/收起任务详情', { taskId: task.id })
                setExpandedId(expanded ? null : task.id)
              }}
              className="list-item-enter cursor-pointer rounded-lg border border-outline-variant bg-surface-container-low p-4 transition-colors hover:border-outline"
              style={{ animationDelay: `${Math.min(i, 15) * 24}ms` }}
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
                  <span className="flex shrink-0 items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
                    <span className="flex items-center gap-1">
                      {sourcePlatform ? (
                        <PlatformLogo
                          platform={sourcePlatform}
                          name={sourceMeta?.name ?? sourcePlatform}
                          icon={sourceMeta?.icon ?? 'library_music'}
                          size="h-4 w-4"
                          iconSize="text-sm"
                        />
                      ) : isLocalSource(task.source) ? (
                        <PlatformLogo
                          platform="local"
                          name={t('syncHistory.sourceLocalPlaylist')}
                          icon="description"
                          size="h-4 w-4"
                          iconSize="text-sm"
                        />
                      ) : (
                        <span className="material-symbols-outlined text-sm">description</span>
                      )}
                      {sourcePlatform
                        ? sourceMeta?.name ?? sourcePlatform
                        : syncSourceLabel(task.source, t)}
                    </span>
                    <span className="material-symbols-outlined text-sm text-outline">
                      arrow_forward
                    </span>
                    <span
                      className="flex items-center gap-1"
                      title={target?.name ?? task.targetPlatform}
                    >
                      <PlatformLogo
                        platform={task.targetPlatform}
                        name={target?.name ?? task.targetPlatform}
                        icon={target?.icon ?? 'library_music'}
                        size="h-4 w-4"
                        iconSize="text-sm"
                      />
                      <span>{target?.name ?? task.targetPlatform}</span>
                    </span>
                  </span>
                  <span className="material-symbols-outlined text-sm text-outline">
                    {expanded ? 'expand_less' : 'expand_more'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {intervenable && <StopTaskButton onStop={() => onStopTask(task.id)} />}
                  {RETRYABLE_STATUSES.includes(task.status) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        log.info('sync.retry-task', '重新执行同步任务', { taskId: task.id })
                        onRetryTask(task)
                      }}
                      disabled={task.detail.length === 0 && task.rawInput.length === 0}
                      title={t('syncHistory.retryTaskHint')}
                      className="flex items-center gap-1 rounded-md border border-outline-variant px-2 py-1 font-label-sm text-label-sm text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                    >
                      <span className="material-symbols-outlined text-sm">replay</span>
                      {t('syncHistory.retryTask')}
                    </button>
                  )}
                  <span className="rounded-full bg-surface-container-highest px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                    {t(statusMeta.labelKey)}
                  </span>
                  <span className="font-label-mono text-label-mono text-outline">
                    {taskTimeText(task, formatDateTime)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      log.info('sync.remove-task', '删除同步任务', { taskId: task.id })
                      onTaskRemove(task.id)
                    }}
                    disabled={task.status === 'running'}
                    title={t('syncHistory.removeTask')}
                    className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error disabled:opacity-40"
                  >
                    <span className="material-symbols-outlined text-base">delete</span>
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
                {taskSummaryKind(task.status) === 'progress' && (
                  <span className="flex items-center gap-1 text-tertiary">
                    <span className="material-symbols-outlined text-sm">refresh</span>
                    {t('syncHistory.matchingProgress', {
                      current: Math.round(task.progress * task.total),
                      total: task.total,
                    })}
                  </span>
                )}
                {taskSummaryKind(task.status) === 'counts' && (
                  <span>
                    {t('syncHistory.success')} <span className="text-primary">{task.added}</span>
                    {counts.failed > 0 && (
                      <>
                        {' '}
                        {t('syncHistory.failedCount')}{' '}
                        <span className="text-error">{counts.failed}</span>
                      </>
                    )}
                  </span>
                )}
                {taskSummaryKind(task.status) === 'failure' && (
                  <span className="flex items-center gap-1 text-error">
                    <span className="material-symbols-outlined text-sm">error_outline</span>
                    {userFacingErrorMessage(firstFailureReason(task) ?? '', t('sync.failedGeneric'))}
                  </span>
                )}
              </div>

              {task.status === 'running' && (
                <div className="mt-3">
                  <ProgressBar ratio={task.progress} />
                </div>
              )}

              {expanded && (
                <div className="detail-enter">
                  <TaskDetailSection
                    task={task}
                    intervenable={intervenable}
                    onStop={() => onStopTask(task.id)}
                  />
                </div>
              )}
            </div>
          )
        })}
        {sortedTasks.length > visibleCount && (
          <LoadMoreSentinel
            onVisible={() =>
              setVisibleCount((c) => Math.min(sortedTasks.length, c + TASK_PAGE_SIZE))
            }
          />
        )}
      </div>
    </div>
  )
}
