import { useEffect, useState } from 'react'
import type { PlatformAccount } from '@core/models/platform'
import LoginSection from './components/LoginSection'
import PlaylistSection from './components/PlaylistSection'
import TextCreator from './components/TextCreator'

export default function App() {
  const [account, setAccount] = useState<PlatformAccount | null>(null)

  useEffect(() => {
    window.electronAPI.netease
      .loginStatus()
      .then(setAccount)
      .catch(() => setAccount(null))
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 p-8 text-slate-800">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">歌单同步</h1>
        <span className="text-xs text-slate-400">本地优先 · 跨平台歌单工具</span>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <LoginSection account={account} onAccountChange={setAccount} />
          <PlaylistSection loggedIn={account !== null} />
        </div>
        <div className="lg:col-span-3">
          <TextCreator loggedIn={account !== null} />
        </div>
      </div>
    </main>
  )
}
