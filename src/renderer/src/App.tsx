import { useEffect, useState } from 'react'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import Sidebar, { type View } from './components/Sidebar'
import TextCreator from './components/TextCreator'
import PlaylistSection from './components/PlaylistSection'
import LoginSection from './components/LoginSection'
import SyncCenter from './components/SyncCenter'
import type { PendingConfirmSession, SyncReport, SyncTaskRecord } from '@core/models/sync'
import SettingsView from './components/SettingsView'
import ConfirmSyncDialog from './components/ConfirmSyncDialog'
import { ToastHost, notify } from './components/toast'
import { createRendererLogger } from './logging/rendererLogger'
import { useI18n } from './i18n'
import { failedDetailLines } from './sync/helpers'

const log = createRendererLogger('renderer.app')

export default function App() {
  const { t } = useI18n()
  const [view, setView] = useState<View>('create')
  const [platforms, setPlatforms] = useState<PlatformMeta[]>([])
  const [accounts, setAccounts] = useState<Record<string, PlatformAccount | null>>({})
  const [tasks, setTasks] = useState<SyncTaskRecord[]>([])
  const [search, setSearch] = useState('')

  // 待确认同步会话提升到 App 层：分步确认弹窗挂载于此，切换视图不丢失
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmSession | null>(null)
  const [confirmSelections, setConfirmSelections] = useState<Record<number, string>>({})
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const [confirmResult, setConfirmResult] = useState<SyncReport | null>(null)

  useEffect(() => {
    window.electronAPI.platforms
      .list()
      .then(async (list) => {
        log.debug('app.init', '初始化平台账号状态', { platforms: list.map((p) => p.id) })
        setPlatforms(list)
        const entries = await Promise.all(
          list.map(async (p) => [p.id, await window.electronAPI.platforms.loginStatus(p.id)] as const),
        )
        setAccounts(Object.fromEntries(entries))
      })
      .catch((e) => {
        log.error('app.init-failed', '初始化平台账号状态失败', e)
        setAccounts({})
      })

    // 恢复同步历史
    window.electronAPI.syncHistory
      .list()
      .then((history) => {
        log.info('app.sync-history-restored', '恢复同步历史', { count: history.length })
        setTasks(history)
      })
      .catch((e) => {
        log.error('app.sync-history-restore-failed', '恢复同步历史失败', e)
      })
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

  // 主进程保活调度可能导致凭证续期或失效，收到广播后重新查询该平台登录态
  useEffect(() => {
    const off = window.electronAPI.platforms.onAccountsChanged((platform) => {
      log.info('app.account-changed', '平台账号状态变化，重新查询登录态', { platform })
      window.electronAPI.platforms
        .loginStatus(platform)
        .then((account) => setAccounts((prev) => ({ ...prev, [platform]: account })))
        .catch((e) => {
          log.error('app.account-refresh-failed', '刷新账号状态失败', e, { platform })
        })
    })
    return off
  }, [])

  const handleAccountChange = (platform: string, account: PlatformAccount | null) => {
    setAccounts((prev) => ({ ...prev, [platform]: account }))
  }

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

  // --- 待确认会话：新会话建立时重置选择与结果状态 ---

  const handlePendingConfirmChange = (session: PendingConfirmSession | null) => {
    setPendingConfirm(session)
    setConfirmSelections({})
    setConfirmResult(null)
    setConfirmError('')
  }

  const resetConfirmSession = () => {
    setPendingConfirm(null)
    setConfirmSelections({})
    setConfirmResult(null)
    setConfirmError('')
  }

  /** 弹窗确认：全部选择完成后调用主进程完成同步 */
  const handleConfirmSync = async () => {
    if (!pendingConfirm || confirming) return
    const { syncTaskId, target, choices } = pendingConfirm
    const sel = choices
      .map((_, i) => ({ choiceIndex: i, songId: confirmSelections[i] }))
      .filter((s) => typeof s.songId === 'string')
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

  /** 同步中心：停止运行中的任务（引擎在下一个检查点中止，任务状态由执行方收敛） */
  const handleStopTask = async (id: string) => {
    log.info('sync.stop-task', '停止同步任务', { taskId: id })
    try {
      await window.electronAPI.platforms.stopSync(id)
    } catch (e) {
      log.error('sync.stop-task-failed', '停止任务失败', e, { taskId: id })
      notify('error', t('toast.syncFailedTitle'), e instanceof Error ? e.message : t('sync.failedGeneric'))
    }
  }

  /** 同步中心：请求跳过当前歌曲，从下一首继续 */
  const handleSkipTask = async (id: string) => {
    log.info('sync.skip-task', '跳过当前歌曲', { taskId: id })
    try {
      await window.electronAPI.platforms.skipSync(id)
      notify('warning', t('toast.skipRequestedTitle'), t('toast.skipRequestedDetail'))
    } catch (e) {
      log.error('sync.skip-task-failed', '跳过请求失败', e, { taskId: id })
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
                platforms={platforms}
                accounts={accounts}
                onTaskUpdate={handleTaskUpdate}
                pendingConfirm={pendingConfirm}
                onPendingConfirmChange={handlePendingConfirmChange}
              />
            )}
            {view === 'playlists' && (
              <PlaylistSection
                platforms={platforms}
                accounts={accounts}
                searchQuery={search}
                onTaskUpdate={handleTaskUpdate}
                pendingConfirm={pendingConfirm}
                onPendingConfirmChange={handlePendingConfirmChange}
              />
            )}
            {view === 'sync' && (
              <SyncCenter
                platforms={platforms}
                tasks={tasks}
                onNewTask={() => setView('create')}
                onTaskRemove={handleTaskRemove}
                onClearAll={handleClearAll}
                pendingChoicesCount={pendingConfirm?.choices.length ?? 0}
                onGoConfirm={() => setView('create')}
                intervenableIds={intervenableIds}
                onStopTask={(id) => void handleStopTask(id)}
                onSkipTask={(id) => void handleSkipTask(id)}
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

      {/* 分步确认弹窗：App 层挂载，切换视图不丢失 */}
      {pendingConfirm && (
        <ConfirmSyncDialog
          session={pendingConfirm}
          selections={confirmSelections}
          onSelect={(index, songId) => setConfirmSelections((prev) => ({ ...prev, [index]: songId }))}
          onConfirm={() => void handleConfirmSync()}
          onCancel={() => void handleCancelPending()}
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
