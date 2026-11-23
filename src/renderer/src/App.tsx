import { useEffect, useState } from 'react'

export default function App() {
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.electronAPI.getVersion().then(setVersion).catch(() => setVersion('未知'))
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 p-10 text-slate-800">
      <h1 className="text-2xl font-semibold">歌单同步</h1>
      <p className="mt-2 text-sm text-slate-500">桌面应用骨架已就绪 · v{version}</p>
    </main>
  )
}
