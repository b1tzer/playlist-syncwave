import { useEffect, useRef, useState } from 'react'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import Sidebar, { type View } from './components/Sidebar'
import TextCreator from './components/TextCreator'
import PlaylistSection from './components/PlaylistSection'
import LoginSection from './components/LoginSection'
import SyncCenter from './components/SyncCenter'
import type { SyncTaskRecord } from '@core/models/sync'
import SettingsView from './components/SettingsView'
import { createRendererLogger } from './logging/rendererLogger'

const log = createRendererLogger('renderer.app')

export default function App() {
  const [view, setView] = useState<View>('create')
  const [platforms, setPlatforms] = useState<PlatformMeta[]>([])
  const [accounts, setAccounts] = useState<Record<string, PlatformAccount | null>>({})
  const [tasks, setTasks] = useState<SyncTaskRecord[]>([])
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

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

  const handleSearch = (value: string) => {
    setSearch(value)
    if (value.trim() && view !== 'playlists') setView('playlists')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      const navigate = (target: View) => {
        log.info('nav.shortcut', '快捷键切换视图', { key: k, view: target })
        setView(target)
      }
      if (k === 'n') {
        e.preventDefault()
        navigate('create')
      } else if (k === 'p') {
        e.preventDefault()
        navigate('playlists')
      } else if (k === 's') {
        e.preventDefault()
        navigate('sync')
      } else if (k === 'a') {
        e.preventDefault()
        navigate('accounts')
      } else if (k === ',') {
        e.preventDefault()
        navigate('settings')
      } else if (k === 'k') {
        e.preventDefault()
        log.debug('nav.focus-search', '快捷键聚焦搜索框')
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runningTasks = tasks.filter((t) => t.status === 'running').length

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        view={view}
        onNavigate={setView}
        runningTasks={runningTasks}
        accounts={accounts}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-outline-variant px-6 py-3">
          <div className="flex w-96 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 transition-colors focus-within:border-primary">
            <span className="material-symbols-outlined text-base text-outline">search</span>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="搜索歌单"
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
            <span className="shrink-0 font-label-mono text-label-mono text-outline">⌘K</span>
          </div>
          <div className="ml-auto flex items-center gap-2 font-label-mono text-label-mono text-outline">
            <span className="material-symbols-outlined text-sm">security</span>
            本地优先 · 凭证经系统钥匙串加密
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-6 py-6">
            {view === 'create' && (
              <TextCreator platforms={platforms} accounts={accounts} onTaskUpdate={handleTaskUpdate} />
            )}
            {view === 'playlists' && (
              <PlaylistSection platforms={platforms} accounts={accounts} searchQuery={search} />
            )}
            {view === 'sync' && (
              <SyncCenter platforms={platforms} tasks={tasks} onNewTask={() => setView('create')} />
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
    </div>
  )
}
