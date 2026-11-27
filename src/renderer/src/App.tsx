import { useCallback, useEffect, useState } from 'react'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import type { MatchQuery } from '@core/models/match'
import Sidebar, { type View } from './components/Sidebar'
import TextCreator from './components/TextCreator'
import PlaylistSection from './components/PlaylistSection'
import LoginSection from './components/LoginSection'
import SyncHistory from './components/SyncHistory'
import type { PendingConfirmSession, SyncTaskRecord } from '@core/models/sync'
import SettingsView from './components/SettingsView'
import ConfirmSyncDialog from './components/ConfirmSyncDialog'
import { ToastHost, notify } from './components/toast'
import { notifyError } from './utils/notifyError'
import { createRendererLogger } from './logging/rendererLogger'
import { useI18n } from './i18n'
import { failedDetailLines, songDupKey } from './sync/helpers'
import { useSyncRunner } from './sync/useSyncRunner'
import { deriveTaskCounts } from '@core/sync/taskStats'
import TaskCenter from './components/TaskCenter'

const log = createRendererLogger('renderer.app')

export default function App() {
  const { t } = useI18n()
  // 同步历史重新执行：App 层持有独立 runner 实例（与各入口组件互不干扰，进度按 taskId 过滤）
  const { run: runRetry } = useSyncRunner()
  const [view, setView] = useState<View>('create')
  // 已访问视图保持挂载：切回时复用列表状态与已加载数据，避免整棵子树重新挂载、重复 IPC 与 0.3s 入场动画
  const [visitedViews, setVisitedViews] = useState<Set<View>>(() => new Set(['create']))
  const navigate = useCallback((next: View) => {
    setView(next)
    setVisitedViews((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
  }, [])
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

  useEffect(() => {
    // StrictMode 下 effect 会先挂载再卸载重挂载：cancelled 防止已卸载轮次的异步回调继续更新状态
    let cancelled = false
    const retryTimers: ReturnType<typeof setTimeout>[] = []

    window.electronAPI.platforms
      .list()
      .then((list) => {
        if (cancelled) return
        log.debug('app.init', '初始化平台账号状态', { platforms: list.map((p) => p.id) })
        setPlatforms(list)
        // 逐平台独立更新：每个平台查询完成立即点亮，慢平台（网络重抓 token 等）
        // 不阻塞已就绪平台的显示（Ctrl+R 后主进程有登录态缓存，通常整体秒回）
        for (const p of list) {
          window.electronAPI.platforms
            .loginStatus(p.id)
            .then((account) => {
              if (!cancelled) setAccounts((prev) => ({ ...prev, [p.id]: account }))
            })
            .catch((e) => {
              if (cancelled) return
              log.warn('app.init-platform-failed', '平台登录态查询失败，暂显示未连接', {
                platform: p.id,
                message: e instanceof Error ? e.message : String(e),
              })
              setAccounts((prev) => ({ ...prev, [p.id]: null }))
              // 查询失败多为网络抖动：3 秒后重试一次，网络恢复后自动纠正显示
              retryTimers.push(
                setTimeout(() => {
                  window.electronAPI.platforms
                    .loginStatus(p.id)
                    .then((account) => {
                      if (!cancelled) setAccounts((prev) => ({ ...prev, [p.id]: account }))
                    })
                    .catch(() => {
                      log.debug('app.init-platform-retry-failed', '重试仍失败，保持未连接显示', {
                        platform: p.id,
                      })
                    })
                }, 3000),
              )
            })
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
      for (const timer of retryTimers) clearTimeout(timer)
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
        navigate(target)
      }
    })
    return off
  }, [navigate])

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
    setConfirmDismissed(false)
  }

  const resetConfirmSession = () => {
    setPendingConfirm(null)
    setConfirmSelections({})
    setConfirmSkips({})
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
          failedDetail: failedDetailLines(t, rep.failed),
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

      // 先建单流程：歌单已创建即为成功；空歌单（0 写入）如实提示，不再虚报失败
      const ok = rep.playlistId !== ''
      if (ok) {
        // 右上角通知：给用户明确的执行结果
        if (rep.added === 0) {
          notify('warning', t('toast.confirmDoneTitle'), t('toast.syncEmptyDetail'))
        } else if (rep.failed.length > 0) {
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
      } else {
        // 未建单（理论上先建单流程不再出现）：兜底提示
        notify(
          'error',
          t('toast.syncNoneTitle'),
          t('toast.syncNoneDetail', { count: rep.failed.length || rep.total }),
        )
      }
      const { task } = pendingConfirm
      // 终态计数以最终明细为权威口径：行摘要与展开明细永远一致
      const counts = deriveTaskCounts(rep.items, {
        added: rep.added,
        failed: rep.failed.length,
      })
      handleTaskUpdate({
        ...task,
        name: rep.playlistName,
        status: ok ? 'done' : 'failed',
        total: rep.total,
        added: counts.added,
        failed: counts.failed,
        progress: 1,
        failedDetail: failedDetailLines(t, rep.failed),
        detail: rep.items,
        playlistId: rep.playlistId || undefined,
      })
      // 写入完成后直接关闭确认弹窗，结果以上方通知呈现
      resetConfirmSession()
    } catch (e) {
      log.error('sync.confirm-failed', '确认同步失败', e, { targetPlatform: target })
      // 错误提示走右上角 toast，代码性报错过滤为通用文案
      notifyError(e, t('toast.syncFailedTitle'))
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
      notifyError(e, t('toast.syncFailedTitle'))
    }
  }

  const handleSearch = (value: string) => {
    setSearch(value)
    if (value.trim() && view !== 'playlists') navigate('playlists')
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
        onNavigate={navigate}
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
          {/* 右上角任务中心：运行中任务显示名称与进度，结束后显示成功/失败与失败原因 */}
          <TaskCenter tasks={tasks} platforms={platforms} />
        </header>

        <main className="flex-1 overflow-y-auto">
          {visitedViews.has('create') && (
            <div className="px-6 py-6" style={{ display: view === 'create' ? undefined : 'none' }}>
              <TextCreator
                platforms={configuredPlatforms}
                accounts={accounts}
                onTaskUpdate={handleTaskUpdate}
                pendingConfirm={pendingConfirm}
                onPendingConfirmChange={handlePendingConfirmChange}
              />
            </div>
          )}
          {visitedViews.has('playlists') && (
            <div
              className="px-6 py-6"
              style={{
                display: view === 'playlists' ? 'flex' : 'none',
                height: view === 'playlists' ? '100%' : undefined,
                flexDirection: 'column',
              }}
            >
              <PlaylistSection
                platforms={configuredPlatforms}
                accounts={accounts}
                searchQuery={search}
                visible={view === 'playlists'}
                onTaskUpdate={handleTaskUpdate}
                pendingConfirm={pendingConfirm}
                onPendingConfirmChange={handlePendingConfirmChange}
              />
            </div>
          )}
          {visitedViews.has('sync') && (
            <div className="px-6 py-6" style={{ display: view === 'sync' ? undefined : 'none' }}>
              <SyncHistory
                platforms={platforms}
                tasks={tasks}
                onNewTask={() => navigate('create')}
                onTaskRemove={handleTaskRemove}
                onClearAll={handleClearAll}
                pendingChoicesCount={pendingConfirm?.choices.length ?? 0}
                onGoConfirm={() => {
                  log.info('sync.go-confirm', '重新打开待确认窗口')
                  setConfirmDismissed(false)
                  navigate('create')
                }}
                intervenableIds={intervenableIds}
                onStopTask={(id) => void handleStopTask(id)}
                onRetryTask={(task) => void handleRetryTask(task)}
              />
            </div>
          )}
          {visitedViews.has('accounts') && (
            <div className="px-6 py-6" style={{ display: view === 'accounts' ? undefined : 'none' }}>
              <LoginSection
                platforms={platforms}
                accounts={accounts}
                onAccountChange={handleAccountChange}
              />
            </div>
          )}
          {visitedViews.has('settings') && (
            <div
              className="px-6 py-6"
              style={{ display: view === 'settings' ? undefined : 'none' }}
            >
              <SettingsView />
            </div>
          )}
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
          confirming={confirming}
        />
      )}

      {/* 右上角全局通知 */}
      <ToastHost />
    </div>
  )
}
