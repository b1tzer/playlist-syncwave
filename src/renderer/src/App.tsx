import { useEffect, useState } from 'react'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import type { MatchQuery } from '@core/models/match'
import Sidebar, { type View } from './components/Sidebar'
import TextCreator from './components/TextCreator'
import PlaylistSection from './components/PlaylistSection'
import LoginSection from './components/LoginSection'
import SyncHistory from './components/SyncHistory'
import type { PendingConfirmSession, SyncReport, SyncTaskRecord } from '@core/models/sync'
import SettingsView from './components/SettingsView'
import ConfirmSyncDialog from './components/ConfirmSyncDialog'
import { ToastHost, notify } from './components/toast'
import { createRendererLogger } from './logging/rendererLogger'
import { useI18n } from './i18n'
import { failedDetailLines, songDupKey } from './sync/helpers'
import { useSyncRunner } from './sync/useSyncRunner'

const log = createRendererLogger('renderer.app')

export default function App() {
  const { t } = useI18n()
  // 同步历史重新执行：App 层持有独立 runner 实例（与各入口组件互不干扰，进度按 taskId 过滤）
  const { run: runRetry } = useSyncRunner()
  const [view, setView] = useState<View>('create')
  const [platforms, setPlatforms] = useState<PlatformMeta[]>([])
  const [accounts, setAccounts] = useState<Record<string, PlatformAccount | null>>({})
  const [tasks, setTasks] = useState<SyncTaskRecord[]>([])
  const [search, setSearch] = useState('')

  // 待确认同步会话提升到 App 层：分步确认弹窗挂载于此，切换视图不丢失
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmSession | null>(null)
  const [confirmSelections, setConfirmSelections] = useState<Record<number, string>>({})
  /** 用户显式跳过（不写入任何版本）的 choice：choiceIndex -> true */
  const [confirmSkips, setConfirmSkips] = useState<Record<number, true>>({})
  /** 「稍后处理」仅收起弹窗，会话保留在 pendingConfirm，可再次打开 */
  const [confirmDismissed, setConfirmDismissed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const [confirmResult, setConfirmResult] = useState<SyncReport | null>(null)

  useEffect(() => {
    // StrictMode 下 effect 会先挂载再卸载重挂载：cancelled 防止已卸载轮次的异步回调继续更新状态
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    window.electronAPI.platforms
      .list()
      .then(async (list) => {
        if (cancelled) return
        log.debug('app.init', '初始化平台账号状态', { platforms: list.map((p) => p.id) })
        setPlatforms(list)
        // 逐平台独立容错：任一平台登录态查询失败（网络超时、平台 500 等）只影响自身，
        // 不得拖垮其他平台（Promise.all 会因单个失败整体 reject，导致界面全部显示未登录）。
        const settled = await Promise.allSettled(
          list.map(async (p) => [p.id, await window.electronAPI.platforms.loginStatus(p.id)] as const),
        )
        if (cancelled) return
        const entries = settled.map((r, i) => {
          const platformId = list[i].id
          if (r.status === 'fulfilled') return [platformId, r.value[1]] as const
          log.warn('app.init-platform-failed', '平台登录态查询失败，暂显示未连接', {
            platform: platformId,
            message: r.reason instanceof Error ? r.reason.message : String(r.reason),
          })
          return [platformId, null] as const
        })
        setAccounts(Object.fromEntries(entries))

        // 查询失败多为网络抖动：3 秒后对失败平台重试一次，网络恢复后自动纠正显示
        const retryIds = list
          .map((p, i) => (settled[i].status === 'rejected' ? p.id : null))
          .filter((id): id is string => id !== null)
        if (retryIds.length > 0) {
          retryTimer = setTimeout(() => {
            for (const platformId of retryIds) {
              window.electronAPI.platforms
                .loginStatus(platformId)
                .then((account) => {
                  if (!cancelled) setAccounts((prev) => ({ ...prev, [platformId]: account }))
                })
                .catch(() => {
                  log.debug('app.init-platform-retry-failed', '重试仍失败，保持未连接显示', {
                    platform: platformId,
                  })
                })
            }
          }, 3000)
        }
      })
      .catch((e) => {
        log.error('app.init-failed', '初始化平台账号状态失败', e)
        if (!cancelled) setAccounts({})
      })

    // 恢复同步历史
    window.electronAPI.syncHistory
      .list()
      .then(async (history) => {
        log.info('app.sync-history-restored', '恢复同步历史', { count: history.length })
        setTasks(history)
        // 刷新/重载后主进程可能仍挂有待确认会话：据此恢复确认窗口，避免选择流程丢失
        try {
          const pendingList = await window.electronAPI.platforms.listPendingConfirms()
          if (cancelled || pendingList.length === 0) return
          const info = pendingList[0]
          const saved = history.find((x) => x.id === info.taskId)
          const task: SyncTaskRecord =
            saved ?? {
              id: info.taskId,
              name: info.playlistName,
              targetPlatform: info.platform,
              source: '',
              status: 'running',
              total: info.choices.length,
              added: 0,
              failed: 0,
              createdAt: '',
              createdAtMs: 0,
              progress: 1,
              failedDetail: [],
              detail: [],
              rawInput: [],
            }
          log.info('app.pending-confirm-restored', '恢复待确认同步会话', {
            taskId: info.taskId,
            choices: info.choices.length,
          })
          setPendingConfirm({
            syncTaskId: info.taskId,
            task,
            target: info.platform,
            choices: info.choices,
          })
        } catch (e) {
          log.warn('app.pending-confirm-restore-failed', '查询待确认会话失败', {
            message: e instanceof Error ? e.message : String(e),
          })
        }
      })
      .catch((e) => {
        log.error('app.sync-history-restore-failed', '恢复同步历史失败', e)
      })

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  // 应用菜单导航快捷键：主进程广播视图切换
  useEffect(() => {
    const off = window.electronAPI.onNavigate((target) => {
      if (
        target === 'create' ||
        target === 'playlists' ||
        target === 'sync' ||
        target === 'accounts' ||
        target === 'settings'
      ) {
        log.info('app.menu-navigate', '菜单导航切换视图', { view: target })
        setView(target)
      }
    })
    return off
  }, [])

  // 主进程执行中定期落库后广播任务快照（含重启后的自动恢复执行）：
  // 渲染层据此实时刷新列表，无需重新全量查询（落库已在主进程完成，这里只更新内存）
  useEffect(() => {
    const off = window.electronAPI.syncHistory.onTaskUpdated((task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((x) => x.id === task.id)
        if (idx === -1) return [task, ...prev]
        const next = [...prev]
        next[idx] = task
        return next
      })
    })
    return off
  }, [])

  // 主进程保活调度可能导致凭证续期或失效，收到广播后重新查询该平台登录态
  useEffect(() => {
    const off = window.electronAPI.platforms.onAccountsChanged((platform) => {
      log.info('app.account-changed', '平台账号状态变化，重新查询登录态', { platform })
      window.electronAPI.platforms
        .loginStatus(platform)
        .then((account) => setAccounts((prev) => ({ ...prev, [platform]: account })))
        .catch((e) => {
          // 查询失败 ≠ 登出：保留上一次状态，避免网络抖动误清登录态
          log.warn('app.account-refresh-failed', '刷新账号状态失败，保留上次状态', {
            platform,
            message: e instanceof Error ? e.message : String(e),
          })
        })
    })
    return off
  }, [])

  const handleAccountChange = (platform: string, account: PlatformAccount | null) => {
    setAccounts((prev) => ({ ...prev, [platform]: account }))
  }

  /**
   * 已连接账号的平台：未配置的平台只出现在「账号管理」页，
   * 完成连接后才在其他页面供用户选择。
   */
  const configuredPlatforms = platforms.filter((p) => accounts[p.id] !== null)

  const handleTaskUpdate = (t: SyncTaskRecord) => {
    setTasks((prev) => {
      const idx = prev.findIndex((x) => x.id === t.id)
      if (idx === -1) return [t, ...prev]
      const next = [...prev]
      next[idx] = t
      return next
    })
    // 落库持久化（失败不影响界面）
    window.electronAPI.syncHistory.upsert(t).catch((e) => {
      log.warn('sync.history-persist-failed', '同步历史落库失败', e)
    })
  }

  const handleTaskRemove = (id: string) => {
    setTasks((prev) => prev.filter((x) => x.id !== id))
    window.electronAPI.syncHistory
      .remove(id)
      .then(() => log.info('sync.remove-task-done', '同步任务已删除', { taskId: id }))
      .catch((e) => log.error('sync.remove-task-failed', '删除同步任务失败', e, { taskId: id }))
  }

  const handleClearAll = () => {
    setTasks([])
    window.electronAPI.syncHistory
      .clear()
      .then(() => log.info('sync.clear-all-done', '同步历史已清空'))
      .catch((e) => log.error('sync.clear-all-failed', '清空同步历史失败', e))
  }

  /**
   * 同步历史重新执行：复用原始输入清单，已匹配项直接复用上次查询到的目标资源（跳过搜索），
   * 其余项重新搜索判定；产生新的任务记录，原历史记录保留。
   */
  const handleRetryTask = async (task: SyncTaskRecord) => {
    // 原始输入优先；旧任务缺失时按明细 index 重建（choice 项 query 为当时判定用的候选）
    const queries: MatchQuery[] =
      task.rawInput.length > 0
        ? task.rawInput
        : [...task.detail].sort((a, b) => a.index - b.index).map((d) => d.query)
    if (queries.length === 0) {
      notify('error', t('toast.syncFailedTitle'), t('syncHistory.retryNoInput'))
      return
    }
    // 已匹配项：dupKey -> songId（连同目标资源关键信息），主进程 lookupMapping 命中后直接复用
    const reuseMatches = task.detail
      .filter((d) => d.status === 'matched' && typeof d.songId === 'string' && d.songId !== '')
      .map((d) => ({ key: songDupKey(d.query), songId: d.songId as string, matchedSong: d.matchedSong }))
    log.info('sync.retry', '重新执行同步任务', {
      taskId: task.id,
      queries: queries.length,
      reuse: reuseMatches.length,
    })
    await runRetry({
      targetPlatform: task.targetPlatform,
      queries,
      name: task.name,
      source: task.source,
      reuseMatches,
      onTaskUpdate: handleTaskUpdate,
      onPendingConfirmChange: handlePendingConfirmChange,
    })
  }

  // --- 待确认会话：新会话建立时重置选择与结果状态 ---

  const handlePendingConfirmChange = (session: PendingConfirmSession | null) => {
    setPendingConfirm(session)
    setConfirmSelections({})
    setConfirmSkips({})
    setConfirmResult(null)
    setConfirmError('')
    setConfirmDismissed(false)
  }

  const resetConfirmSession = () => {
    setPendingConfirm(null)
    setConfirmSelections({})
    setConfirmSkips({})
    setConfirmResult(null)
    setConfirmError('')
    setConfirmDismissed(false)
  }

  /** 弹窗「稍后处理」：仅收起确认窗口，会话保留，可从同步历史重新打开 */
  const handleDismissConfirm = () => {
    log.info('sync.dismiss-pending', '稍后处理待确认同步', {
      taskId: pendingConfirm?.syncTaskId,
    })
    setConfirmDismissed(true)
  }

  /** 弹窗确认：全部选择完成后调用主进程完成同步 */
  const handleConfirmSync = async () => {
    if (!pendingConfirm || confirming) return
    const { syncTaskId, target, choices } = pendingConfirm
    // 每首歌要么选定一个版本、要么显式跳过；未决的 choice 阻止确认
    const sel = choices
      .map((_, i) => {
        if (confirmSkips[i]) return { choiceIndex: i, songId: '', skipped: true }
        const songId = confirmSelections[i]
        return typeof songId === 'string' ? { choiceIndex: i, songId } : null
      })
      .filter((s): s is { choiceIndex: number; songId: string; skipped?: boolean } => s !== null)
    if (sel.length < choices.length) return

    log.info('sync.confirm', '确认手动选择并继续同步', {
      targetPlatform: target,
      selections: sel.length,
    })
    setConfirming(true)
    setConfirmError('')
    try {
      const rep = await window.electronAPI.platforms.confirmSync(target, syncTaskId, sel)
      log.info('sync.confirm-done', '确认同步完成', {
        targetPlatform: target,
        playlistId: rep.playlistId,
        added: rep.added,
        failed: rep.failed.length,
      })

      if (rep.status === 'stopped') {
        // 确认后的写入被用户停止：任务归为 stopped，弹窗关闭
        const { task } = pendingConfirm
        handleTaskUpdate({
          ...task,
          status: 'stopped',
          added: rep.added,
          failed: rep.failed.length,
          progress: 1,
          failedDetail: failedDetailLines(rep.failed),
          detail: rep.items,
          playlistId: rep.playlistId || undefined,
        })
        resetConfirmSession()
        notify(
          'warning',
          t('toast.syncStoppedTitle'),
          t('toast.syncStoppedDetail', { name: rep.playlistName }),
        )
        return
      }

      setConfirmResult(rep)
      const ok = rep.playlistId !== ''
      if (ok) {
        // 右上角通知：给用户明确的执行结果
        if (rep.failed.length > 0) {
          notify(
            'warning',
            t('toast.confirmDoneTitle'),
            t('toast.confirmPartialDetail', {
              added: rep.added,
              name: rep.playlistName,
              failed: rep.failed.length,
            }),
          )
        } else {
          notify(
            'success',
            t('toast.confirmDoneTitle'),
            t('toast.confirmDoneDetail', { added: rep.added, name: rep.playlistName }),
          )
        }
      }
      const { task } = pendingConfirm
      handleTaskUpdate({
        ...task,
        name: rep.playlistName,
        status: ok ? 'done' : 'failed',
        total: rep.total,
        added: rep.added,
        failed: rep.failed.length,
        progress: 1,
        failedDetail: failedDetailLines(rep.failed),
        detail: rep.items,
        playlistId: rep.playlistId || undefined,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('sync.failedGeneric')
      log.error('sync.confirm-failed', '确认同步失败', e, { targetPlatform: target })
      setConfirmError(msg)
      notify('error', t('toast.syncFailedTitle'), msg)
    } finally {
      setConfirming(false)
    }
  }

  /** 弹窗取消：主进程放弃会话，任务归为已中断 */
  const handleCancelPending = async () => {
    if (!pendingConfirm) return
    log.info('sync.cancel-pending', '取消待确认同步', { taskId: pendingConfirm.syncTaskId })
    try {
      await window.electronAPI.platforms.cancelSync(pendingConfirm.syncTaskId)
    } catch (e) {
      log.error('sync.cancel-pending-failed', '放弃同步会话失败', e, {
        taskId: pendingConfirm.syncTaskId,
      })
    }
    const { task } = pendingConfirm
    handleTaskUpdate({
      ...task,
      status: 'interrupted',
      failedDetail: [...task.failedDetail, '任务已取消：用户放弃手动选择'],
    })
    resetConfirmSession()
  }

  /** 同步历史：停止运行中的任务（引擎在下一个检查点中止，任务状态由执行方收敛） */
  const handleStopTask = async (id: string) => {
    log.info('sync.stop-task', '停止同步任务', { taskId: id })
    try {
      await window.electronAPI.platforms.stopSync(id)
    } catch (e) {
      log.error('sync.stop-task-failed', '停止任务失败', e, { taskId: id })
      notify('error', t('toast.syncFailedTitle'), e instanceof Error ? e.message : t('sync.failedGeneric'))
    }
  }

  const handleSearch = (value: string) => {
    setSearch(value)
    if (value.trim() && view !== 'playlists') setView('playlists')
  }

  const runningTasks = tasks.filter((t) => t.status === 'running').length

  // 可介入（停止/跳过）的任务：执行中，且不在「等待手动确认选择」阶段（确认弹窗执行写入时也允许停止）
  const pendingTaskId = pendingConfirm?.syncTaskId ?? null
  const intervenableIds = tasks
    .filter((t) => t.status === 'running' && (t.id !== pendingTaskId || confirming))
    .map((t) => t.id)

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        view={view}
        onNavigate={setView}
        runningTasks={runningTasks}
        accounts={accounts}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          // macOS 无标题栏：顶部条作为窗口拖拽区，搜索框内单独恢复交互
          className={`flex items-center gap-4 border-b border-outline-variant px-6 py-3 ${
            window.electronAPI.platform === 'darwin' ? '[-webkit-app-region:drag]' : ''
          }`}
        >
          <div
            className={`flex w-96 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 transition-colors focus-within:border-primary ${
              window.electronAPI.platform === 'darwin' ? '[-webkit-app-region:no-drag]' : ''
            }`}
          >
            <span className="material-symbols-outlined text-base text-outline">search</span>
            <input
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder={t('app.searchPlaceholder')}
              className="w-full bg-transparent font-body-md text-body-md text-on-surface outline-none placeholder:text-outline"
            />
            {search && (
              <button
                onClick={() => {
                  log.info('search.clear', '清空搜索')
                  handleSearch('')
                }}
                className="text-outline transition-colors hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div
            key={view}
            className={`view-enter px-6 py-6 ${view === 'playlists' ? 'flex h-full flex-col' : ''}`}
          >
            {view === 'create' && (
              <TextCreator
                platforms={configuredPlatforms}
                accounts={accounts}
                onTaskUpdate={handleTaskUpdate}
                pendingConfirm={pendingConfirm}
                onPendingConfirmChange={handlePendingConfirmChange}
              />
            )}
            {view === 'playlists' && (
              <PlaylistSection
                platforms={configuredPlatforms}
                accounts={accounts}
                searchQuery={search}
                onTaskUpdate={handleTaskUpdate}
                pendingConfirm={pendingConfirm}
                onPendingConfirmChange={handlePendingConfirmChange}
              />
            )}
            {view === 'sync' && (
              <SyncHistory
                platforms={platforms}
                tasks={tasks}
                onNewTask={() => setView('create')}
                onTaskRemove={handleTaskRemove}
                onClearAll={handleClearAll}
                pendingChoicesCount={pendingConfirm?.choices.length ?? 0}
                onGoConfirm={() => {
                  log.info('sync.go-confirm', '重新打开待确认窗口')
                  setConfirmDismissed(false)
                  setView('create')
                }}
                intervenableIds={intervenableIds}
                onStopTask={(id) => void handleStopTask(id)}
                onRetryTask={(task) => void handleRetryTask(task)}
              />
            )}
            {view === 'accounts' && (
              <LoginSection
                platforms={platforms}
                accounts={accounts}
                onAccountChange={handleAccountChange}
              />
            )}
            {view === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>

      {/* 分步确认弹窗：App 层挂载，切换视图不丢失；「稍后处理」收起后仍可从同步历史重新打开 */}
      {pendingConfirm && !confirmDismissed && (
        <ConfirmSyncDialog
          session={pendingConfirm}
          selections={confirmSelections}
          skips={confirmSkips}
          onSelect={(index, songId) => {
            setConfirmSelections((prev) => ({ ...prev, [index]: songId }))
            // 重新选择候选即取消跳过
            setConfirmSkips((prev) => {
              if (!prev[index]) return prev
              const next = { ...prev }
              delete next[index]
              return next
            })
          }}
          onSkip={(index) => {
            setConfirmSkips((prev) => ({ ...prev, [index]: true }))
            // 跳过即清除已选候选
            setConfirmSelections((prev) => {
              if (!prev[index]) return prev
              const next = { ...prev }
              delete next[index]
              return next
            })
          }}
          onConfirm={() => void handleConfirmSync()}
          onCancel={() => void handleCancelPending()}
          onDismiss={handleDismissConfirm}
          onDone={resetConfirmSession}
          confirming={confirming}
          confirmError={confirmError}
          confirmResult={confirmResult}
        />
      )}

      {/* 右上角全局通知 */}
      <ToastHost />
    </div>
  )
}
