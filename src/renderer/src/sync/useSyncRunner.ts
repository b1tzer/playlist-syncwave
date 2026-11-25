import { useCallback, useState } from 'react'
import type { MatchQuery } from '@core/models/match'
import type {
  PendingConfirmSession,
  SyncItemResult,
  SyncMatchedResource,
  SyncReport,
  SyncTaskRecord,
} from '@core/models/sync'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import { notify } from '../components/toast'
import { syncFailedText } from './helpers'

const log = createRendererLogger('renderer.sync-runner')

export interface SyncRunnerProgress {
  ratio: number
  stage: 'matching' | 'adding'
}

interface RunSyncArgs {
  targetPlatform: string
  queries: MatchQuery[]
  /** 歌单名（空串由主进程自动命名） */
  name: string
  source: string
  /** 重新执行时复用上次已匹配结果（dupKey -> songId），命中后跳过搜索 */
  reuseMatches?: Array<{ key: string; songId: string; matchedSong?: SyncMatchedResource }>
  onTaskUpdate: (task: SyncTaskRecord) => void
  onPendingConfirmChange: (session: PendingConfirmSession | null) => void
}

/**
 * 同步执行流程（建任务 → 进度/明细订阅 → 四种结果收敛与通知）。
 * 文本导入与歌单导入共用：调用方只负责准备 queries。
 */
export function useSyncRunner() {
  const { t, formatDateTime, formatDate } = useI18n()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SyncRunnerProgress | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [error, setError] = useState('')

  const reset = useCallback(() => {
    setReport(null)
    setError('')
  }, [])

  const run = useCallback(
    async ({
      targetPlatform,
      queries,
      name,
      source,
      reuseMatches,
      onTaskUpdate,
      onPendingConfirmChange,
    }: RunSyncArgs) => {
      setRunning(true)
      setError('')
      setReport(null)
      setProgress({ ratio: 0, stage: 'matching' })

      const taskId = `task-${Date.now()}`
      const now = new Date()
      const createdAt = formatDateTime(now)
      const autoNameDate = formatDate(now)
      const baseTask: SyncTaskRecord = {
        id: taskId,
        name: name || autoNameDate,
        targetPlatform,
        source,
        status: 'running',
        total: queries.length,
        added: 0,
        failed: 0,
        createdAt,
        // 绝对时间戳：排序与展示的权威依据（展示层按当前时区实时格式化，改时区自动换算）
        createdAtMs: now.getTime(),
        progress: 0,
        failedDetail: [],
        detail: [],
        // 原始输入随任务持久化：重新执行时直接复用
        rawInput: queries,
      }
      onTaskUpdate(baseTask)

      // 逐首明细实时累积（主进程 sync:step 广播），供同步历史详情清单展示
      const detailRef: SyncItemResult[] = []
      const offProgress = window.electronAPI.platforms.onSyncProgress((p) => {
        if (p.taskId !== taskId) return
        setProgress(p)
        onTaskUpdate({ ...baseTask, progress: p.ratio, detail: [...detailRef] })
      })
      const offStep = window.electronAPI.platforms.onSyncStep((step) => {
        if (step.taskId !== taskId) return
        // 同 index 明细覆盖（失败项重试后可能转为成功）
        const idx = detailRef.findIndex((d) => d.index === step.item.index)
        if (idx === -1) detailRef.push(step.item)
        else detailRef[idx] = step.item
        onTaskUpdate({ ...baseTask, progress: baseTask.progress, detail: [...detailRef] })
      })

      try {
        const { taskId: syncTaskId, report: rep } = await window.electronAPI.platforms.syncPlaylist(
          targetPlatform,
          taskId,
          queries,
          name,
          autoNameDate,
          undefined,
          reuseMatches,
        )
        const finalDetail = rep.items ?? [...detailRef]

        if (rep.status === 'choice-needed') {
          log.info('runner.choice-needed', '同步需要手动选择', {
            targetPlatform,
            choices: rep.choices.length,
          })
          const runningTask: SyncTaskRecord = {
            ...baseTask,
            name: rep.playlistName,
            failed: rep.failed.length,
            progress: 1,
            failedDetail: rep.failed.map((f) => syncFailedText(t, f)),
            detail: finalDetail,
          }
          onTaskUpdate(runningTask)
          // 会话提升到 App 层：分步确认弹窗接管选择流程
          onPendingConfirmChange({
            syncTaskId,
            task: runningTask,
            target: targetPlatform,
            choices: rep.choices,
          })
          return
        }

        if (rep.status === 'stopped') {
          log.info('runner.stopped', '同步被用户停止', {
            targetPlatform,
            added: rep.added,
          })
          onTaskUpdate({
            ...baseTask,
            name: rep.playlistName,
            status: 'stopped',
            added: rep.added,
            failed: rep.failed.length,
            progress: 1,
            failedDetail: rep.failed.map((f) => syncFailedText(t, f)),
            detail: finalDetail,
          })
          notify(
            'warning',
            t('toast.syncStoppedTitle'),
            t('toast.syncStoppedDetail', { name: rep.playlistName }),
          )
          return
        }

        setReport(rep)
        const ok = rep.playlistId !== ''
        log.info('runner.done', '同步结束', {
          targetPlatform,
          playlistId: rep.playlistId,
          added: rep.added,
          failed: rep.failed.length,
        })
        if (ok) {
          if (rep.failed.length > 0) {
            notify(
              'warning',
              t('toast.syncDoneTitle'),
              t('toast.syncPartialDetail', {
                added: rep.added,
                total: rep.total,
                name: rep.playlistName,
                failed: rep.failed.length,
              }),
            )
          } else {
            notify(
              'success',
              t('toast.syncDoneTitle'),
              t('toast.syncDoneDetail', {
                added: rep.added,
                total: rep.total,
                name: rep.playlistName,
              }),
            )
          }
        } else {
          notify(
            'error',
            t('toast.syncNoneTitle'),
            t('toast.syncNoneDetail', { count: rep.failed.length || rep.total }),
          )
        }
        onTaskUpdate({
          ...baseTask,
          name: rep.playlistName,
          status: ok ? 'done' : 'failed',
          added: rep.added,
          failed: rep.failed.length,
          progress: 1,
          failedDetail: rep.failed.map((f) => syncFailedText(t, f)),
          detail: finalDetail,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : t('sync.failedGeneric')
        log.error('runner.failed', '同步失败', e, { targetPlatform })
        setError(msg)
        notify('error', t('toast.syncFailedTitle'), msg)
        onTaskUpdate({
          ...baseTask,
          status: 'failed',
          added: 0,
          failed: queries.length,
          progress: 1,
          failedDetail: [msg],
          detail: [...detailRef],
        })
      } finally {
        offProgress()
        offStep()
        setRunning(false)
        setProgress(null)
      }
    },
    [t, formatDateTime, formatDate],
  )

  return { run, running, progress, report, error, reset }
}
