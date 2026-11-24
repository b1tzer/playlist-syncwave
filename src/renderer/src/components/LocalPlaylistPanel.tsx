import { useEffect, useState } from 'react'
import type { LocalPlaylist, LocalPlaylistSong } from '@core/models/localPlaylist'
import type { MatchQuery } from '@core/models/match'
import type { PlatformAccount, PlatformMeta, PlatformSong } from '@core/models/platform'
import type { PendingConfirmSession, SyncTaskRecord } from '@core/models/sync'
import { toM3u } from '@core/export/toM3u'
import { toCsv } from '@core/export/toCsv'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import { useSyncRunner } from '../sync/useSyncRunner'
import { songDupKey } from '../sync/helpers'
import SongList from './SongList'
import PlatformLogo from './PlatformLogo'
import { notify } from './toast'
import { operationAllowed } from '../utils/platformCapabilities'

const log = createRendererLogger('renderer.local-playlist')

interface LocalPlaylistPanelProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  onTaskUpdate: (task: SyncTaskRecord) => void
  pendingConfirm: PendingConfirmSession | null
  onPendingConfirmChange: (session: PendingConfirmSession | null) => void
}

export default function LocalPlaylistPanel({
  platforms,
  accounts,
  onTaskUpdate,
  pendingConfirm,
  onPendingConfirmChange,
}: LocalPlaylistPanelProps) {
  const { t } = useI18n()
  const { run, running: syncRunning } = useSyncRunner()

  const [playlists, setPlaylists] = useState<LocalPlaylist[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [songs, setSongs] = useState<LocalPlaylistSong[]>([])
  const [loadingSongs, setLoadingSongs] = useState(false)

  // 新建 / 重命名
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 同步目标平台选择
  const [syncPicker, setSyncPicker] = useState(false)
  // 导出格式选择
  const [exportPicker, setExportPicker] = useState(false)

  // 添加歌曲：搜索已登录平台
  const [searchPlatform, setSearchPlatform] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<PlatformSong[] | null>(null)
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set())

  const activePlaylist = playlists.find((p) => p.id === activeId) ?? null
  const loggedPlatforms = platforms.filter((p) => accounts[p.id] !== null)

  const fetchPlaylists = async () => {
    try {
      const list = await window.electronAPI.localPlaylists.list()
      setPlaylists(list)
      if (activeId !== null && !list.some((p) => p.id === activeId)) {
        setActiveId(list[0]?.id ?? null)
        setSongs([])
      }
      return list
    } catch (e) {
      log.error('local-playlist.list-failed', '拉取本地歌单失败', e)
      notify('error', t('localPlaylist.listFailed'))
      return []
    }
  }

  useEffect(() => {
    void fetchPlaylists()
  }, [])

  const loadSongs = async (id: string) => {
    setLoadingSongs(true)
    try {
      const list = await window.electronAPI.localPlaylists.songs(id)
      setSongs(list)
    } catch (e) {
      log.error('local-playlist.songs-failed', '拉取本地歌单歌曲失败', e)
      setSongs([])
    } finally {
      setLoadingSongs(false)
    }
  }

  const handleSelect = (id: string) => {
    setActiveId(id)
    void loadSongs(id)
  }

  const handleCreate = async () => {
    const name = createDraft.trim()
    if (!name) return
    try {
      const created = await window.electronAPI.localPlaylists.create(name, [])
      log.info('local-playlist.created', '本地歌单已创建', { id: created?.id })
      setCreating(false)
      setCreateDraft('')
      const list = await fetchPlaylists()
      if (created) {
        setActiveId(created.id)
        setSongs([])
      } else if (list.length > 0) {
        setActiveId(list[0].id)
        setSongs([])
      }
      notify('success', t('localPlaylist.created'), t('localPlaylist.createdDetail', { name }))
    } catch (e) {
      log.error('local-playlist.create-failed', '创建本地歌单失败', e)
      notify('error', t('localPlaylist.createFailed'), e instanceof Error ? e.message : '')
    }
  }

  const handleRename = async () => {
    const name = renameDraft.trim()
    if (!name || !activeId) return
    try {
      await window.electronAPI.localPlaylists.rename(activeId, name)
      log.info('local-playlist.renamed', '本地歌单已重命名', { id: activeId })
      setRenaming(false)
      await fetchPlaylists()
    } catch (e) {
      log.error('local-playlist.rename-failed', '重命名失败', e)
      notify('error', t('localPlaylist.renameFailed'))
    }
  }

  const handleDelete = async () => {
    if (!activeId) return
    try {
      await window.electronAPI.localPlaylists.delete(activeId)
      log.info('local-playlist.deleted', '本地歌单已删除', { id: activeId })
      setConfirmDelete(false)
      setActiveId(null)
      setSongs([])
      await fetchPlaylists()
    } catch (e) {
      log.error('local-playlist.delete-failed', '删除失败', e)
      notify('error', t('localPlaylist.deleteFailed'))
    }
  }

  const handleRemoveSong = async (songId: number) => {
    if (!activeId) return
    try {
      await window.electronAPI.localPlaylists.removeSongs(activeId, [songId])
      setSongs((prev) => prev.filter((s) => s.id !== songId))
      await fetchPlaylists()
      log.info('local-playlist.song-removed', '已从本地歌单移除歌曲', { id: activeId })
    } catch (e) {
      log.error('local-playlist.song-remove-failed', '移除歌曲失败', e)
      notify('error', t('localPlaylist.removeFailed'))
    }
  }

  const handleSearch = async () => {
    const keyword = searchInput.trim()
    if (!keyword || !searchPlatform) return
    setSearching(true)
    setSearchResults(null)
    try {
      const results = await window.electronAPI.platforms.searchSongs(searchPlatform, keyword, 30)
      setSearchResults(results)
    } catch (e) {
      log.error('local-playlist.search-failed', '搜索平台歌曲失败', e, { platform: searchPlatform })
      notify('error', t('localPlaylist.searchFailed'))
    } finally {
      setSearching(false)
    }
  }

  const handleAddSong = async (song: PlatformSong) => {
    if (!activeId || addingIds.has(song.id)) return
    setAddingIds((prev) => new Set(prev).add(song.id))
    try {
      await window.electronAPI.localPlaylists.addSongs(activeId, [
        {
          title: song.title,
          artist: song.artist ?? '',
          album: song.album,
          durationMs: song.durationMs,
        },
      ])
      setSearchResults((prev) => prev?.filter((s) => s.id !== song.id) ?? null)
      await loadSongs(activeId)
      await fetchPlaylists()
      log.info('local-playlist.song-added', '已添加歌曲到本地歌单', { id: activeId, songId: song.id })
    } catch (e) {
      log.error('local-playlist.song-add-failed', '添加歌曲失败', e)
      notify('error', t('localPlaylist.addFailed'))
    } finally {
      setAddingIds((prev) => {
        const next = new Set(prev)
        next.delete(song.id)
        return next
      })
    }
  }

  /** 导出当前歌单为 m3u/csv 文件 */
  const handleExport = async (format: 'm3u' | 'csv') => {
    if (!activePlaylist || songs.length === 0) return
    setExportPicker(false)
    const exportSongs = songs.map((s) => ({
      title: s.title,
      artist: s.artist || undefined,
      album: s.album,
      durationMs: s.durationMs,
    }))
    const content = format === 'm3u' ? toM3u(exportSongs) : toCsv(exportSongs)
    try {
      const saved = await window.electronAPI.saveTextFile(activePlaylist.name, content, format)
      log.info('local-playlist.exported', '歌单已导出', { id: activeId, format, saved })
      if (saved) notify('success', t('localPlaylist.exported'), saved)
    } catch (e) {
      log.error('local-playlist.export-failed', '导出失败', e, { id: activeId })
      notify('error', t('localPlaylist.exportFailed'))
    }
  }

  const handleSyncTo = async (targetPlatform: string) => {
    if (!activeId || songs.length === 0) return
    setSyncPicker(false)
    // 去重后转同步查询
    const seen = new Set<string>()
    const queries: MatchQuery[] = []
    for (const s of songs) {
      const key = songDupKey(s)
      if (seen.has(key)) continue
      seen.add(key)
      queries.push({
        title: s.title,
        artist: s.artist || undefined,
        album: s.album,
        durationMs: s.durationMs,
      })
    }
    log.info('local-playlist.sync-to', '从本地歌单发起同步', {
      id: activeId,
      targetPlatform,
      total: queries.length,
    })
    await run({
      targetPlatform,
      queries,
      name: activePlaylist?.name ?? '',
      source: 'local-playlist',
      onTaskUpdate,
      onPendingConfirmChange,
    })
  }

  /** 同步目标：已登录 + 具备建单/加曲能力（能力清单由平台适配器声明） */
  const syncTargets = platforms.filter(
    (p) =>
      accounts[p.id] !== null &&
      operationAllowed(p, 'createPlaylist') &&
      operationAllowed(p, 'addSongs'),
  )

  return (
    <div className="mt-6 flex min-h-0 flex-1 gap-4">
      {/* 左：本地歌单列表 */}
      <div className="flex w-72 min-h-0 shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-outline-variant bg-surface-container-low">
          <div className="flex shrink-0 items-center justify-between border-b border-outline-variant px-3 py-2">
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {t('localPlaylist.listTitle')}
            </span>
            <button
              onClick={() => {
                setCreating(true)
                setCreateDraft('')
              }}
              disabled={creating}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-label-sm text-label-sm text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base">add</span>
              {t('localPlaylist.new')}
            </button>
          </div>

          {creating && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-3 py-2">
              <input
                autoFocus
                value={createDraft}
                onChange={(e) => setCreateDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate()
                  if (e.key === 'Escape') setCreating(false)
                }}
                placeholder={t('localPlaylist.namePlaceholder')}
                className="min-w-0 flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary"
              />
              <button
                onClick={() => void handleCreate()}
                disabled={!createDraft.trim()}
                className="rounded-md bg-primary px-2 py-1 font-label-sm text-label-sm font-medium text-on-primary disabled:opacity-40"
              >
                {t('localPlaylist.create')}
              </button>
              <button
                onClick={() => setCreating(false)}
                className="rounded-md px-2 py-1 font-label-sm text-label-sm text-on-surface-variant hover:text-on-surface"
              >
                {t('localPlaylist.cancel')}
              </button>
            </div>
          )}

          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {playlists.length === 0 && (
              <li className="px-2 py-2 font-label-md text-label-md text-outline">
                {t('localPlaylist.empty')}
              </li>
            )}
            {playlists.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => handleSelect(p.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                    activeId === p.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-on-surface hover:bg-surface-container-high'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg">queue_music</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-label-md text-label-md">{p.name}</span>
                    <span className="block font-label-sm text-label-sm text-on-surface-variant">
                      {t('localPlaylist.songCount', { count: p.songCount })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 右：歌单详情 */}
      <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-outline-variant bg-surface-container-low">
        {!activePlaylist ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <span className="material-symbols-outlined text-5xl text-outline">library_music</span>
            <p className="font-body-md text-body-md text-on-surface-variant">
              {t('localPlaylist.empty')}
            </p>
            <p className="max-w-sm font-label-sm text-label-sm text-outline">
              {t('localPlaylist.emptyHint')}
            </p>
          </div>
        ) : (
          <>
            {/* 头部：重命名 / 同步 / 删除 */}
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
              {renaming ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRename()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                  className="min-w-0 flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1 font-body-md text-body-md text-on-surface outline-none focus:border-primary"
                />
              ) : (
                <h2 className="min-w-0 flex-1 truncate font-headline-lg text-headline-lg font-semibold">
                  {activePlaylist.name}
                </h2>
              )}
              <button
                onClick={() => {
                  setRenaming(true)
                  setRenameDraft(activePlaylist.name)
                }}
                title={t('localPlaylist.rename')}
                className="flex items-center rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary"
              >
                <span className="material-symbols-outlined text-base">edit</span>
              </button>
              <div className="relative">
                <button
                  onClick={() => {
                    setExportPicker((v) => !v)
                    setSyncPicker(false)
                  }}
                  disabled={songs.length === 0}
                  title={t('localPlaylist.export')}
                  className="flex items-center rounded-md border border-outline-variant p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-base">download</span>
                </button>
                {exportPicker && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                    {(['m3u', 'csv'] as const).map((format) => (
                      <button
                        key={format}
                        onClick={() => void handleExport(format)}
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-highest"
                      >
                        {format.toUpperCase()}
                        <span className="material-symbols-outlined text-sm text-outline">download</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  onClick={() => {
                    setSyncPicker((v) => !v)
                    setExportPicker(false)
                  }}
                  disabled={syncRunning || pendingConfirm !== null || songs.length === 0}
                  title={t('localPlaylist.syncTo')}
                  className="flex items-center gap-1 rounded-md border border-outline-variant px-2.5 py-1.5 font-label-md text-label-md text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-base">sync_alt</span>
                  {t('localPlaylist.syncTo')}
                </button>
                {syncPicker && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                    {syncTargets.length === 0 ? (
                      <p className="px-2 py-1.5 font-label-sm text-label-sm text-outline">
                        {t('localPlaylist.selectTarget')}
                      </p>
                    ) : (
                      syncTargets.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => void handleSyncTo(p.id)}
                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-highest"
                        >
                          <PlatformLogo platform={p.id} name={p.name} icon={p.icon} />
                          {p.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              {confirmDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="font-label-sm text-label-sm text-error">
                    {t('localPlaylist.deleteConfirm', { name: activePlaylist.name })}
                  </span>
                  <button
                    onClick={() => void handleDelete()}
                    className="rounded-md bg-error px-2 py-1 font-label-sm text-label-sm font-medium text-on-error"
                  >
                    {t('localPlaylist.delete')}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-md px-2 py-1 font-label-sm text-label-sm text-on-surface-variant hover:text-on-surface"
                  >
                    {t('localPlaylist.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  title={t('localPlaylist.delete')}
                  className="flex items-center rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
                >
                  <span className="material-symbols-outlined text-base">delete_outline</span>
                </button>
              )}
            </div>

            {/* 添加歌曲搜索区 */}
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
              <div className="flex items-center gap-1">
                {loggedPlatforms.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSearchPlatform(p.id)
                      setSearchResults(null)
                      setSearchInput('')
                    }}
                    title={p.name}
                    className={`rounded-md p-1 transition-colors ${
                      searchPlatform === p.id ? 'bg-primary/15 text-primary' : 'text-outline hover:text-on-surface'
                    }`}
                  >
                    <PlatformLogo platform={p.id} name={p.name} icon={p.icon} />
                  </button>
                ))}
              </div>
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSearch()
                }}
                placeholder={t('localPlaylist.searchPlaceholder')}
                disabled={!searchPlatform}
                className="min-w-0 flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary disabled:opacity-50"
              />
              <button
                onClick={() => void handleSearch()}
                disabled={!searchPlatform || !searchInput.trim() || searching}
                className="rounded-md border border-outline-variant px-2.5 py-1 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-40"
              >
                {searching ? t('common.loading') : t('localPlaylist.search')}
              </button>
            </div>

            {/* 搜索结果候选区 */}
            {searchResults !== null && (
              <div className="max-h-52 shrink-0 overflow-y-auto border-b border-outline-variant p-1.5">
                {searchResults.length === 0 ? (
                  <p className="px-2 py-2 font-label-md text-label-md text-outline">
                    {t('localPlaylist.noResults')}
                  </p>
                ) : (
                  searchResults.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-container-highest"
                    >
                      <span className="min-w-0 flex-1 truncate font-label-md text-label-md text-on-surface">
                        {s.title}
                        <span className="text-on-surface-variant">{s.artist ? ` - ${s.artist}` : ''}</span>
                      </span>
                      <button
                        onClick={() => void handleAddSong(s)}
                        disabled={addingIds.has(s.id)}
                        className="flex items-center gap-0.5 rounded-md bg-primary/15 px-2 py-1 font-label-sm text-label-sm text-primary transition-colors hover:bg-primary/25 disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-sm">add</span>
                        {t('localPlaylist.add')}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 歌曲列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loadingSongs ? (
                <p className="px-2 py-2 font-label-md text-label-md text-outline">{t('common.loading')}</p>
              ) : songs.length === 0 ? (
                <p className="px-2 py-2 font-label-md text-label-md text-outline">
                  {t('localPlaylist.emptySongs')}
                </p>
              ) : (
                <SongList
                  songs={songs.map((s) => ({
                    id: String(s.id),
                    title: s.title,
                    artist: s.artist ?? '',
                    album: s.album,
                    durationMs: s.durationMs,
                  }))}
                  showIndex
                  renderAction={(song) => (
                    <button
                      onClick={() => void handleRemoveSong(Number(song.id))}
                      title={t('localPlaylist.remove')}
                      className="flex items-center rounded-md p-1 text-outline opacity-0 transition-opacity hover:bg-surface-container-highest hover:text-error group-hover:opacity-100"
                    >
                      <span className="material-symbols-outlined text-base">close</span>
                    </button>
                  )}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
