import { useCallback, useEffect, useState } from 'react'
import type {
  PlatformAccount,
  PlatformMeta,
  PlatformPlaylist,
  PlatformSong,
} from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'

const log = createRendererLogger('renderer.playlist')

interface PlaylistSectionProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  searchQuery: string
}

export default function PlaylistSection({ platforms, accounts, searchQuery }: PlaylistSectionProps) {
  const { t } = useI18n()
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

  // --- 歌单管理操作状态 ---
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [managing, setManaging] = useState(false)
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<PlatformSong[] | null>(null)
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set())

  const loggedIn = active !== '' && accounts[active] !== null
  const keyword = searchQuery.trim().toLowerCase()

  /** 当前平台是否声明写能力（歌单管理操作仅写平台可用） */
  const canManage = platforms.find((p) => p.id === active)?.capabilities.write === true
  const activePlaylist = playlists.find((p) => p.id === activeId)

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
      setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
    } finally {
      setLoading(false)
    }
  }, [active, loggedIn, t])

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
    // 切换歌单时重置管理操作状态
    setRenaming(false)
    setConfirmDelete(false)
    setSearchResults(null)
    setSearchInput('')
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
      setError(e instanceof Error ? e.message : t('playlist.fetchSongsFailed'))
    } finally {
      setLoading(false)
    }
  }

  // --- 歌单管理操作 ---

  const startRename = () => {
    if (!activePlaylist) return
    setRenameDraft(activePlaylist.name)
    setRenaming(true)
    setConfirmDelete(false)
  }

  const handleRename = async () => {
    const name = renameDraft.trim()
    if (!name || !activeId) return
    log.info('playlist.rename', '重命名歌单', { platform: active, playlistId: activeId })
    setManaging(true)
    setError('')
    try {
      await window.electronAPI.platforms.renamePlaylist(active, activeId, name)
      setPlaylists((prev) => prev.map((p) => (p.id === activeId ? { ...p, name } : p)))
      setRenaming(false)
    } catch (e) {
      log.error('playlist.rename-failed', '重命名失败', e, { platform: active, playlistId: activeId })
      setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
    } finally {
      setManaging(false)
    }
  }

  const handleDelete = async () => {
    if (!activeId) return
    log.info('playlist.delete', '删除歌单', { platform: active, playlistId: activeId })
    setManaging(true)
    setError('')
    try {
      await window.electronAPI.platforms.deletePlaylist(active, activeId)
      setPlaylists((prev) => prev.filter((p) => p.id !== activeId))
      setSongs([])
      setActiveId(null)
      setConfirmDelete(false)
      setSearchResults(null)
    } catch (e) {
      log.error('playlist.delete-failed', '删除歌单失败', e, { platform: active, playlistId: activeId })
      setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
    } finally {
      setManaging(false)
    }
  }

  const handleRemoveSong = async (songId: string) => {
    if (!activeId) return
    log.info('playlist.remove-song', '从歌单移除歌曲', {
      platform: active,
      playlistId: activeId,
      songId,
    })
    setRemovingIds((prev) => new Set(prev).add(songId))
    setError('')
    try {
      await window.electronAPI.platforms.removeSongsFromPlaylist(active, activeId, [songId])
      setSongs((prev) => prev.filter((s) => s.id !== songId))
    } catch (e) {
      log.error('playlist.remove-song-failed', '移除歌曲失败', e, {
        platform: active,
        playlistId: activeId,
        songId,
      })
      setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(songId)
        return next
      })
    }
  }

  const handleSearch = async () => {
    const kw = searchInput.trim()
    if (!kw) return
    log.info('playlist.search-songs', '搜索歌曲', { platform: active, keyword: kw })
    setSearching(true)
    setError('')
    try {
      const results = await window.electronAPI.platforms.searchSongs(active, kw)
      setSearchResults(results)
    } catch (e) {
      log.error('playlist.search-failed', '搜索歌曲失败', e, { platform: active, keyword: kw })
      setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
    } finally {
      setSearching(false)
    }
  }

  const handleAddSong = async (song: PlatformSong) => {
    if (!activeId) return
    log.info('playlist.add-song', '添加歌曲到歌单', {
      platform: active,
      playlistId: activeId,
      songId: song.id,
    })
    setAddingIds((prev) => new Set(prev).add(song.id))
    setError('')
    try {
      await window.electronAPI.platforms.addSongsToPlaylist(active, activeId, [song.id])
      setSearchResults((prev) => prev?.filter((s) => s.id !== song.id) ?? null)
      setSongs((prev) => (prev.some((s) => s.id === song.id) ? prev : [...prev, song]))
    } catch (e) {
      log.error('playlist.add-song-failed', '添加歌曲失败', e, {
        platform: active,
        playlistId: activeId,
        songId: song.id,
      })
      setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
    } finally {
      setAddingIds((prev) => {
        const next = new Set(prev)
        next.delete(song.id)
        return next
      })
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">
            {t('playlist.title')}
          </h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            {t('playlist.subtitle')}
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
            {t('playlist.loginFirst')}
          </p>
          <p className="mt-1 font-label-sm text-label-sm text-outline">
            {t('playlist.loginHint', {
              platform: platforms.find((p) => p.id === active)?.name ?? active,
            })}
          </p>
        </div>
      ) : (
        <div className="mt-6 flex gap-4">
          <div className="w-64 shrink-0">
            <div className="rounded-lg border border-outline-variant bg-surface-container-low">
              <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {t('playlist.listTitle')}
                  </span>
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing || loading}
                    title={t('playlist.refresh')}
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
                    {t('common.loading')}
                  </li>
                )}
                {!loading && visiblePlaylists.length === 0 && (
                  <li className="px-2 py-2 font-label-md text-label-md text-outline">
                    {keyword ? t('playlist.noMatch') : t('playlist.empty')}
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
            <div className="flex items-center justify-between gap-2 border-b border-outline-variant px-4 py-2">
              <div className="flex min-w-0 items-center gap-2">
                {activeId ? (
                  renaming && activePlaylist ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleRename()
                          if (e.key === 'Escape') setRenaming(false)
                        }}
                        placeholder={t('playlist.renamePlaceholder')}
                        disabled={managing}
                        className="w-48 rounded-md border border-outline-variant bg-surface px-2 py-1 font-label-sm text-label-sm text-on-surface outline-none focus:border-primary disabled:opacity-50"
                      />
                      <button
                        onClick={() => void handleRename()}
                        disabled={managing || !renameDraft.trim()}
                        title={t('playlist.save')}
                        className="flex items-center rounded-md p-1 text-primary transition-colors hover:bg-surface-container-highest disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-base">check</span>
                      </button>
                      <button
                        onClick={() => setRenaming(false)}
                        disabled={managing}
                        title={t('playlist.cancel')}
                        className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-base">close</span>
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="truncate font-label-sm text-label-sm text-on-surface-variant">
                        {activePlaylist?.name ?? ''}
                      </span>
                      {canManage && (
                        <button
                          onClick={startRename}
                          title={t('playlist.rename')}
                          className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary"
                        >
                          <span className="material-symbols-outlined text-base">edit</span>
                        </button>
                      )}
                    </>
                  )
                ) : (
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {t('playlist.selectHint')}
                  </span>
                )}
                <span className="shrink-0 font-label-mono text-label-mono text-outline">
                  {platforms.find((p) => p.id === active)?.name ?? active}
                </span>
              </div>
              {activeId && canManage && (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {t('playlist.songList', { count: songs.length })}
                  </span>
                  <button
                    onClick={() => (confirmDelete ? void handleDelete() : setConfirmDelete(true))}
                    disabled={managing}
                    title={t('playlist.delete')}
                    className={`flex items-center gap-1 rounded-md px-2 py-1 font-label-sm text-label-sm transition-colors disabled:opacity-50 ${
                      confirmDelete
                        ? 'bg-error/10 text-error hover:bg-error/15'
                        : 'text-on-surface-variant hover:bg-surface-container-highest hover:text-error'
                    }`}
                  >
                    <span className="material-symbols-outlined text-base">
                      {confirmDelete ? 'warning' : 'delete'}
                    </span>
                    {confirmDelete ? t('playlist.deleteConfirm') : t('playlist.delete')}
                  </button>
                </div>
              )}
            </div>
            {error && <p className="px-4 py-2 font-label-sm text-label-sm text-error">{error}</p>}
            {loading && (
              <p className="px-4 py-2 font-label-md text-label-md text-outline">
                {t('common.loading')}
              </p>
            )}
            {!loading && activeId && canManage && (
              <div className="border-b border-outline-variant px-4 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
                    <span className="material-symbols-outlined text-base text-primary">
                      playlist_add
                    </span>
                    {t('playlist.addSongs')}
                  </span>
                  <input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSearch()
                    }}
                    placeholder={t('playlist.searchPlaceholder')}
                    disabled={searching}
                    className="min-w-0 flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1 font-body-md text-body-md text-on-surface outline-none focus:border-primary disabled:opacity-50"
                  />
                  <button
                    onClick={() => void handleSearch()}
                    disabled={searching || !searchInput.trim()}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-2 py-1 font-label-sm text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary disabled:opacity-50"
                  >
                    <span
                      className={`material-symbols-outlined text-base ${searching ? 'animate-spin' : ''}`}
                    >
                      {searching ? 'progress_activity' : 'search'}
                    </span>
                    {t('playlist.search')}
                  </button>
                </div>
                {searchResults && (
                  <ul className="mt-2 max-h-40 divide-y divide-outline-variant overflow-y-auto rounded-md border border-outline-variant">
                    {searchResults.length === 0 ? (
                      <li className="px-3 py-2 font-label-sm text-label-sm text-outline">
                        {t('playlist.noSearchResult')}
                      </li>
                    ) : (
                      searchResults.map((s) => (
                        <li
                          key={s.id}
                          className="flex items-center gap-3 px-3 py-1.5 font-body-md text-body-md"
                        >
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <span className="truncate text-on-surface-variant">{s.artist}</span>
                          <button
                            onClick={() => void handleAddSong(s)}
                            disabled={addingIds.has(s.id)}
                            className="flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-2 py-0.5 font-label-sm text-label-sm text-primary transition-colors hover:bg-surface-container-high disabled:opacity-50"
                          >
                            <span className="material-symbols-outlined text-sm">
                              {addingIds.has(s.id) ? 'progress_activity' : 'add'}
                            </span>
                            {t('playlist.added')}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}
            {!loading && activeId && (
              <ul className="max-h-[30rem] divide-y divide-outline-variant overflow-y-auto">
                {songs.map((s, i) => (
                  <li
                    key={s.id}
                    className="group flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md"
                  >
                    <span className="w-6 shrink-0 text-right font-label-mono text-label-mono text-outline">
                      {i + 1}
                    </span>
                    <span className="truncate">{s.title}</span>
                    <span className="truncate text-on-surface-variant">{s.artist}</span>
                    {canManage && (
                      <button
                        onClick={() => void handleRemoveSong(s.id)}
                        disabled={removingIds.has(s.id)}
                        title={t('playlist.removeSong')}
                        className="ml-auto flex shrink-0 items-center rounded-md p-1 text-on-surface-variant opacity-0 transition-all hover:bg-error/10 hover:text-error group-hover:opacity-100 disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-base ${removingIds.has(s.id) ? 'animate-spin' : ''}`}
                        >
                          {removingIds.has(s.id) ? 'progress_activity' : 'playlist_remove'}
                        </span>
                      </button>
                    )}
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
