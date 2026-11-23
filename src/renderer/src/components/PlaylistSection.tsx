import { useEffect, useState } from 'react'
import type { PlatformAccount, PlatformPlaylist, PlatformSong } from '@core/models/platform'

interface PlaylistSectionProps {
  accounts: Record<string, PlatformAccount | null>
}

const PLATFORM_NAMES: Record<string, string> = {
  netease: '网易云',
  qqmusic: 'QQ音乐',
}

export default function PlaylistSection({ accounts }: PlaylistSectionProps) {
  const [active, setActive] = useState<string>('netease')
  const [playlists, setPlaylists] = useState<PlatformPlaylist[]>([])
  const [songs, setSongs] = useState<PlatformSong[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  const loggedIn = accounts[active] !== null

  useEffect(() => {
    setPlaylists([])
    setSongs([])
    setActiveId(null)
    if (!loggedIn) return
    setLoading(true)
    setError('')
    window.electronAPI.platforms
      .userPlaylists(active)
      .then(setPlaylists)
      .catch((e) => setError(e instanceof Error ? e.message : '拉取歌单失败'))
      .finally(() => setLoading(false))
  }, [active, loggedIn])

  const openPlaylist = async (id: string) => {
    setActiveId(id)
    setLoading(true)
    setError('')
    try {
      setSongs(await window.electronAPI.platforms.playlistSongs(active, id))
    } catch (e) {
      setError(e instanceof Error ? e.message : '拉取歌曲失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-800">我的歌单</h2>
        <div className="flex gap-1">
          {Object.keys(PLATFORM_NAMES).map((p) => (
            <button
              key={p}
              onClick={() => setActive(p)}
              className={`rounded-lg px-2.5 py-1 text-xs ${
                active === p
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
            >
              {PLATFORM_NAMES[p]}
            </button>
          ))}
        </div>
      </div>

      {!loggedIn ? (
        <p className="mt-3 text-sm text-slate-400">登录后查看你的歌单</p>
      ) : (
        <div className="mt-3 flex gap-4">
          <ul className="w-56 shrink-0 space-y-1">
            {loading && playlists.length === 0 && (
              <li className="text-sm text-slate-400">加载中…</li>
            )}
            {playlists.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => openPlaylist(p.id)}
                  className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
                    activeId === p.id
                      ? 'bg-red-50 text-red-600'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {p.name}
                  <span className="ml-1 text-xs text-slate-400">{p.songCount}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1">
            {error && <p className="mb-2 text-sm text-red-500">{error}</p>}
            {loading && <p className="text-sm text-slate-400">加载中…</p>}
            {!loading && activeId && (
              <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                {songs.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className="w-6 text-right text-xs text-slate-400">{i + 1}</span>
                    <span className="truncate text-slate-700">{s.title}</span>
                    <span className="truncate text-xs text-slate-400">{s.artist}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
