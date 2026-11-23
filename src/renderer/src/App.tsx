import { useEffect, useState } from 'react'
import type { PlatformAccount } from '@core/models/platform'
import LoginSection from './components/LoginSection'
import PlaylistSection from './components/PlaylistSection'
import TextCreator from './components/TextCreator'

export default function App() {
  const [accounts, setAccounts] = useState<Record<string, PlatformAccount | null>>({})

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

  return (
    <main className="min-h-screen bg-slate-50 p-8 text-slate-800">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">歌单同步</h1>
        <span className="text-xs text-slate-400">本地优先 · 跨平台歌单工具</span>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <LoginSection accounts={accounts} onAccountChange={handleAccountChange} />
          <PlaylistSection accounts={accounts} />
        </div>
        <div className="lg:col-span-3">
          <TextCreator accounts={accounts} />
        </div>
      </div>
    </main>
  )
}
