import { useEffect, useRef, useState } from 'react'
import type { PlatformAccount } from '@core/models/platform'
import Sidebar, { type View } from './components/Sidebar'
import TextCreator from './components/TextCreator'
import PlaylistSection from './components/PlaylistSection'
import LoginSection from './components/LoginSection'
import SyncCenter, { type SyncTaskRecord } from './components/SyncCenter'
import SettingsView from './components/SettingsView'

export default function App() {
  const [view, setView] = useState<View>('create')
  const [accounts, setAccounts] = useState<Record<string, PlatformAccount | null>>({})
  const [tasks, setTasks] = useState<SyncTaskRecord[]>([])
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.electronAPI.platforms
      .list()
      .then(async (platforms) => {
        const entries = await Promise.all(
          platforms.map(async (p) => [p, await window.electronAPI.platforms.loginStatus(p)] as const),
        )
        setAccounts(Object.fromEntries(entries))
      })
      .catch(() => setAccounts({}))
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
  }

  const handleSearch = (value: string) => {
    setSearch(value)
    if (value.trim() && view !== 'playlists') setView('playlists')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'n') {
        e.preventDefault()
        setView('create')
      } else if (k === 'p') {
        e.preventDefault()
        setView('playlists')
      } else if (k === 's') {
        e.preventDefault()
        setView('sync')
      } else if (k === 'a') {
        e.preventDefault()
        setView('accounts')
      } else if (k === ',') {
        e.preventDefault()
        setView('settings')
      } else if (k === 'k') {
        e.preventDefault()
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
                onClick={() => handleSearch('')}
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
              <TextCreator accounts={accounts} onTaskUpdate={handleTaskUpdate} />
            )}
            {view === 'playlists' && (
              <PlaylistSection accounts={accounts} searchQuery={search} />
            )}
            {view === 'sync' && <SyncCenter tasks={tasks} onNewTask={() => setView('create')} />}
            {view === 'accounts' && (
              <LoginSection accounts={accounts} onAccountChange={handleAccountChange} />
            )}
            {view === 'settings' && <SettingsView />}
          </div>
        </main>
      </div>
    </div>
  )
}
