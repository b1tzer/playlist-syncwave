import { useCallback, useEffect, useState } from 'react'
import type {
  PlatformAccount,
  PlatformMeta,
  PlatformPlaylist,
  PlatformSong,
} from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'

const log = createRendererLogger('renderer.playlist')

interface PlaylistSectionProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  searchQuery: string
}

export default function PlaylistSection({ platforms, accounts, searchQuery }: PlaylistSectionProps) {
  const [active, setActive] = useState<string>('')

  // 平台列表动态变化时，校正当前选中的平台
  useEffect(() => {
    if (!platforms.some((p) => p.id === active)) {
      setActive(platforms[0]?.id ?? '')
    }
  }, [platforms, active])
  const [playlists, setPlaylists] = useState<PlatformPlaylist[]>([])
  const [songs, setSongs] = useState<PlatformSong[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>('')

  const loggedIn = active !== '' && accounts[active] !== null
  const keyword = searchQuery.trim().toLowerCase()

  const visiblePlaylists = keyword
    ? playlists.filter((p) => p.name.toLowerCase().includes(keyword))
    : playlists

  const fetchPlaylists = useCallback(async () => {
    if (!loggedIn) return
    setLoading(true)
    setError('')
    try {
      const list = await window.electronAPI.platforms.userPlaylists(active)
      log.info('playlist.list.fetch', '拉取歌单列表', { platform: active, count: list.length })
      setPlaylists(list)
    } catch (e) {
      log.error('playlist.list.fetch-failed', '拉取歌单列表失败', e, { platform: active })
      setError(e instanceof Error ? e.message : '拉取歌单失败')
    } finally {
      setLoading(false)
    }
  }, [active, loggedIn])

  useEffect(() => {
    setPlaylists([])
    setSongs([])
    setActiveId(null)
    void fetchPlaylists()
  }, [fetchPlaylists])

  const handleRefresh = async () => {
    log.info('playlist.list.refresh', '手动刷新歌单列表', { platform: active })
    setRefreshing(true)
    await fetchPlaylists()
    setRefreshing(false)
  }

  const openPlaylist = async (id: string) => {
    setActiveId(id)
    setLoading(true)
    setError('')
    try {
      const list = await window.electronAPI.platforms.playlistSongs(active, id)
      log.info('playlist.songs.fetch', '拉取歌单歌曲', {
        platform: active,
        playlistId: id,
        count: list.length,
      })
      setSongs(list)
    } catch (e) {
      log.error('playlist.songs.fetch-failed', '拉取歌曲失败', e, { platform: active, playlistId: id })
      setError(e instanceof Error ? e.message : '拉取歌曲失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-label-mono text-label-mono text-primary">
            <span className="material-symbols-outlined text-sm">library_music</span>
            <span>MODULE://PLAYLIST_BROWSER</span>
          </div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">我的歌单</h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            浏览已授权平台的歌单与歌曲，作为同步任务的来源
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-outline-variant bg-surface-container-low p-1">
          {platforms.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                log.info('playlist.platform-switch', '切换歌单平台', { platform: p.id })
                setActive(p.id)
              }}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-label-md text-label-md transition-colors ${
                active === p.id
                  ? 'bg-surface-container-highest text-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-base">{p.icon}</span>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {!loggedIn ? (
        <div className="mt-6 flex flex-col items-center rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-6 py-14 text-center">
          <span className="material-symbols-outlined text-5xl text-outline">queue_music</span>
          <p className="mt-3 font-body-md text-body-md text-on-surface-variant">
            登录后查看你的歌单
          </p>
          <p className="mt-1 font-label-sm text-label-sm text-outline">
            前往「账号管理」扫码登录 {platforms.find((p) => p.id === active)?.name ?? active}
          </p>
        </div>
      ) : (
        <div className="mt-6 flex gap-4">
          <div className="w-64 shrink-0">
            <div className="rounded-lg border border-outline-variant bg-surface-container-low">
              <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    歌单列表
                  </span>
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing || loading}
                    title="刷新歌单列表"
                    className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary disabled:opacity-50"
                  >
                    <span
                      className={`material-symbols-outlined text-base ${refreshing ? 'animate-spin' : ''}`}
                    >
                      refresh
                    </span>
                  </button>
                </div>
                <span className="font-label-mono text-label-mono text-outline">
                  {playlists.length}
                </span>
              </div>
              <ul className="max-h-[32rem] space-y-0.5 overflow-y-auto p-1.5">
                {loading && playlists.length === 0 && (
                  <li className="px-2 py-2 font-label-md text-label-md text-outline">
                    加载中…
                  </li>
                )}
                {!loading && visiblePlaylists.length === 0 && (
                  <li className="px-2 py-2 font-label-md text-label-md text-outline">
                    {keyword ? '没有匹配的歌单' : '暂无歌单'}
                  </li>
                )}
                {visiblePlaylists.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => openPlaylist(p.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                        activeId === p.id
                          ? 'bg-primary-container/15 text-primary'
                          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      <span className="material-symbols-outlined text-base">
                        {activeId === p.id ? 'playlist_play' : 'queue_music'}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-body-md text-body-md">
                        {p.name}
                      </span>
                      <span className="font-label-mono text-label-mono text-outline">
                        {p.songCount}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-low">
            <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2">
              <span className="font-label-sm text-label-sm text-on-surface-variant">
                {activeId ? `歌曲列表 · ${songs.length} 首` : '选择左侧歌单查看歌曲'}
              </span>
              {activeId && (
                <span className="font-label-mono text-label-mono text-outline">
                  {platforms.find((p) => p.id === active)?.name ?? active}
                </span>
              )}
            </div>
            {error && <p className="px-4 py-2 font-label-sm text-label-sm text-error">{error}</p>}
            {loading && (
              <p className="px-4 py-2 font-label-md text-label-md text-outline">加载中…</p>
            )}
            {!loading && activeId && (
              <ul className="max-h-[30rem] divide-y divide-outline-variant overflow-y-auto">
                {songs.map((s, i) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md"
                  >
                    <span className="w-6 text-right font-label-mono text-label-mono text-outline">
                      {i + 1}
                    </span>
                    <span className="truncate">{s.title}</span>
                    <span className="truncate text-on-surface-variant">{s.artist}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
