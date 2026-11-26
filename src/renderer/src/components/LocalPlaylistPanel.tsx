import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
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
import SongSearchResults from './SongSearchResults'
import PlatformLogo from './PlatformLogo'
import { notify } from './toast'
import { notifyError } from '../utils/notifyError'
import { operationAllowed } from '../utils/platformCapabilities'
import CoverImage from './CoverImage'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import MarqueeText from './MarqueeText'
import {
  playlistCountClass,
  playlistEmptyClass,
  playlistListClass,
  playlistNameClass,
  playlistRenameInputClass,
  playlistRenameRowClass,
  playlistRowAnimationClass,
  playlistRowClass,
} from './playlistRowStyles'

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
  /** 已完成入场动画的行：与平台歌单列表共用错峰淡入效果 */
  const [enteredIds, setEnteredIds] = useState<Set<string>>(new Set())
  const markEntered = (id: string) => {
    setEnteredIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  // 新建 / 重命名
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  /** 行内重命名：正在列表中原地编辑的歌单 id（双击行触发） */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const inlineRenameInputRef = useRef<HTMLInputElement>(null)
  const renameSubmittingRef = useRef(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 进入行内编辑时聚焦输入框
  useEffect(() => {
    if (renamingId) inlineRenameInputRef.current?.focus()
  }, [renamingId])

  // 同步目标平台选择
  const [syncPicker, setSyncPicker] = useState(false)
  // 导出格式选择
  const [exportPicker, setExportPicker] = useState(false)
  // 本地歌单列表右键菜单
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    entries: ContextMenuEntry[]
  } | null>(null)

  // 添加歌曲：搜索已登录平台
  const [searchPlatform, setSearchPlatform] = useState('')
  const [searchInput, setSearchInput] = useState('')
  /** 搜索面板展开（聚焦输入框展开，点击面板外收起） */
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<PlatformSong[] | null>(null)
  /** 搜索结果是否还有下一页（返回条数达到单页上限即视为有） */
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searchLoadingMore, setSearchLoadingMore] = useState(false)
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set())
  /** 本次会话中已添加成功的搜索歌曲 */
  const [addedSongIds, setAddedSongIds] = useState<Set<string>>(new Set())
  const searchPageRef = useRef(1)
  const searchLoadingMoreRef = useRef(false)

  /** 平台搜索单页大小：QQ 音乐单页上限 20，统一按 20 分页（各平台均支持） */
  const SEARCH_PAGE_SIZE = 20

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
    return window.electronAPI.localPlaylists.onChanged(() => {
      void fetchPlaylists()
    })
  }, [])

  /** 读取指定歌单歌曲：选中加载与右键菜单操作共用 */
  const fetchSongs = async (id: string) => window.electronAPI.localPlaylists.songs(id)

  const loadSongs = async (id: string) => {
    setLoadingSongs(true)
    try {
      setSongs(await fetchSongs(id))
    } catch (e) {
      log.error('local-playlist.songs-failed', '拉取本地歌单歌曲失败', e)
      setSongs([])
    } finally {
      setLoadingSongs(false)
    }
  }

  const handleSelect = (id: string) => {
    setActiveId(id)
    setRenamingId(null)
    // 切换歌单重置搜索会话
    setSearchResults(null)
    setSearchHasMore(false)
    setSearchOpen(false)
    setAddedSongIds(new Set())
    searchPageRef.current = 1
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
      notifyError(e, t('localPlaylist.createFailed'))
    }
  }

  /** 提交重命名：头部编辑与行内编辑共用 */
  const submitRename = async (id: string | null): Promise<boolean> => {
    const name = renameDraft.trim()
    if (!name || !id || renameSubmittingRef.current) return false
    renameSubmittingRef.current = true
    try {
      await window.electronAPI.localPlaylists.rename(id, name)
      log.info('local-playlist.renamed', '本地歌单已重命名', { id })
      await fetchPlaylists()
      return true
    } catch (e) {
      log.error('local-playlist.rename-failed', '重命名失败', e)
      notify('error', t('localPlaylist.renameFailed'))
      return false
    } finally {
      renameSubmittingRef.current = false
    }
  }

  const handleRename = async () => {
    if (await submitRename(activeId)) setRenaming(false)
  }

  /** 行内编辑提交：成功后退出该行编辑态 */
  const handleInlineRename = async () => {
    if (await submitRename(renamingId)) setRenamingId(null)
  }

  /** 行内编辑失焦：有效新名字则提交，空名/未改名则退出编辑态 */
  const handleInlineBlur = () => {
    if (!renamingId) return
    const target = playlists.find((p) => p.id === renamingId)
    const name = renameDraft.trim()
    if (!name || (target && name === target.name)) {
      setRenamingId(null)
      return
    }
    void handleInlineRename()
  }

  /** 头部编辑失焦：有效新名字则提交，空名/未改名则退出编辑态 */
  const handleHeaderBlur = () => {
    const name = renameDraft.trim()
    if (!name || !activePlaylist || name === activePlaylist.name) {
      setRenaming(false)
      return
    }
    void handleRename()
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

  /** 批量移除歌曲（行内单曲删除与列表多选删除共用）；本地歌曲 id 即歌单内序号 */
  const handleRemoveSongs = async (songIds: number[]): Promise<boolean> => {
    if (!activeId || songIds.length === 0) return false
    try {
      await window.electronAPI.localPlaylists.removeSongs(activeId, songIds)
      const removed = new Set(songIds)
      // 主进程删除后重排 position，界面序号同步重排，避免后续删除错位
      setSongs((prev) => prev.filter((s) => !removed.has(s.id)).map((s, i) => ({ ...s, id: i })))
      await fetchPlaylists()
      log.info('local-playlist.song-removed', '已从本地歌单移除歌曲', {
        id: activeId,
        count: songIds.length,
      })
      return true
    } catch (e) {
      log.error('local-playlist.song-remove-failed', '移除歌曲失败', e)
      notify('error', t('localPlaylist.removeFailed'))
      return false
    }
  }

  const handleSearch = async (page = 1) => {
    const keyword = searchInput.trim()
    if (!keyword || !searchPlatform) return
    const isFirstPage = page === 1
    if (isFirstPage) {
      setSearching(true)
      setSearchResults(null)
    } else {
      setSearchLoadingMore(true)
    }
    try {
      const results = await window.electronAPI.platforms.searchSongs(
        searchPlatform,
        keyword,
        SEARCH_PAGE_SIZE,
        page,
      )
      searchPageRef.current = page
      setSearchResults((prev) => (isFirstPage ? results : [...(prev ?? []), ...results]))
      // 返回达到单页上限即视为可能还有下一页（滚动到底继续加载，多余一次空请求无害）
      setSearchHasMore(results.length === SEARCH_PAGE_SIZE)
      setSearchOpen(true)
    } catch (e) {
      log.error('local-playlist.search-failed', '搜索平台歌曲失败', e, { platform: searchPlatform })
      notify('error', t('localPlaylist.searchFailed'))
    } finally {
      setSearching(false)
      setSearchLoadingMore(false)
    }
  }

  /** 滚动接近底部提前加载下一页搜索结果 */
  const loadMoreSearch = async () => {
    if (searchLoadingMoreRef.current || !searchHasMore) return
    searchLoadingMoreRef.current = true
    try {
      await handleSearch(searchPageRef.current + 1)
    } finally {
      searchLoadingMoreRef.current = false
    }
  }

  const handleAddSong = async (song: PlatformSong) => {
    if (!activeId || addingIds.has(song.id) || addedSongIds.has(song.id)) return
    setAddingIds((prev) => new Set(prev).add(song.id))
    try {
      await window.electronAPI.localPlaylists.addSongs(activeId, [
        {
          title: song.title,
          artist: song.artist ?? '',
          album: song.album,
          durationMs: song.durationMs,
          coverUrl: song.coverUrl,
        },
      ])
      // 添加成功：结果行保留并标记「已添加」，不再从结果里移除
      setAddedSongIds((prev) => new Set(prev).add(song.id))
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

  /** 导出指定歌单为 m3u/csv 文件（头部按钮与右键菜单共用） */
  const exportPlaylist = async (
    playlist: LocalPlaylist,
    playlistSongs: LocalPlaylistSong[],
    format: 'm3u' | 'csv',
  ) => {
    if (playlistSongs.length === 0) return
    const exportSongs = playlistSongs.map((s) => ({
      title: s.title,
      artist: s.artist || undefined,
      album: s.album,
      durationMs: s.durationMs,
    }))
    const content = format === 'm3u' ? toM3u(exportSongs) : toCsv(exportSongs)
    try {
      const saved = await window.electronAPI.saveTextFile(playlist.name, content, format)
      log.info('local-playlist.exported', '歌单已导出', { id: playlist.id, format, saved })
      if (saved) notify('success', t('localPlaylist.exported'), saved)
    } catch (e) {
      log.error('local-playlist.export-failed', '导出失败', e, { id: playlist.id })
      notify('error', t('localPlaylist.exportFailed'))
    }
  }

  const handleExport = async (format: 'm3u' | 'csv') => {
    if (!activePlaylist || songs.length === 0) return
    setExportPicker(false)
    await exportPlaylist(activePlaylist, songs, format)
  }

  /** 从指定歌单发起同步（头部按钮与右键菜单共用） */
  const syncPlaylist = async (
    playlist: LocalPlaylist,
    playlistSongs: LocalPlaylistSong[],
    targetPlatform: string,
  ) => {
    if (syncRunning || pendingConfirm !== null || playlistSongs.length === 0) return
    // 去重后转同步查询
    const seen = new Set<string>()
    const queries: MatchQuery[] = []
    for (const s of playlistSongs) {
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
      id: playlist.id,
      targetPlatform,
      total: queries.length,
    })
    await run({
      targetPlatform,
      queries,
      name: playlist.name,
      source: 'local-playlist',
      onTaskUpdate,
      onPendingConfirmChange,
    })
  }

  const handleSyncTo = async (targetPlatform: string) => {
    if (!activePlaylist || songs.length === 0) return
    setSyncPicker(false)
    await syncPlaylist(activePlaylist, songs, targetPlatform)
  }

  /** 同步目标：已登录 + 具备建单/加曲能力（能力清单由平台适配器声明） */
  const syncTargets = platforms.filter(
    (p) =>
      accounts[p.id] !== null &&
      operationAllowed(p, 'createPlaylist') &&
      operationAllowed(p, 'addSongs'),
  )

  const handleMenuSync = async (playlist: LocalPlaylist, targetPlatform: string) => {
    try {
      await syncPlaylist(playlist, await fetchSongs(playlist.id), targetPlatform)
    } catch (e) {
      log.error('local-playlist.sync-fetch-failed', '读取本地歌单歌曲失败', e, { id: playlist.id })
      notify('error', t('localPlaylist.songsFailed'))
    }
  }

  const handleMenuExport = async (playlist: LocalPlaylist, format: 'm3u' | 'csv') => {
    try {
      await exportPlaylist(playlist, await fetchSongs(playlist.id), format)
    } catch (e) {
      log.error('local-playlist.export-fetch-failed', '读取本地歌单歌曲失败', e, {
        id: playlist.id,
      })
      notify('error', t('localPlaylist.songsFailed'))
    }
  }

  /** 右键行：先选中该行（详情与删除确认随之指向目标），再按目标歌单构建菜单 */
  const handleRowContextMenu = (e: ReactMouseEvent, playlist: LocalPlaylist) => {
    e.preventDefault()
    log.debug('local-playlist.context-menu', '打开本地歌单右键菜单', { id: playlist.id })
    if (activeId !== playlist.id) handleSelect(playlist.id)

    const hasSongs = playlist.songCount > 0
    const syncBlocked = syncRunning || pendingConfirm !== null
    const entries: ContextMenuEntry[] = [
      {
        type: 'item',
        id: 'rename',
        label: t('localPlaylist.rename'),
        icon: 'edit',
        onSelect: () => {
          setRenameDraft(playlist.name)
          setRenamingId(playlist.id)
        },
      },
    ]
    if (syncTargets.length > 0) {
      entries.push({ type: 'divider', id: 'divider-sync' })
      for (const p of syncTargets) {
        entries.push({
          type: 'item',
          id: `sync-${p.id}`,
          label: t('playlist.syncToPlatform', { platform: p.name }),
          iconNode: (
            <PlatformLogo
              platform={p.id}
              name={p.name}
              icon={p.icon}
              size="h-4 w-4"
              iconSize="text-sm"
            />
          ),
          disabled: !hasSongs || syncBlocked,
          onSelect: () => void handleMenuSync(playlist, p.id),
        })
      }
    }
    entries.push({ type: 'divider', id: 'divider-export' })
    entries.push({
      type: 'item',
      id: 'export-m3u',
      label: t('playlist.exportM3u'),
      icon: 'download',
      disabled: !hasSongs,
      onSelect: () => void handleMenuExport(playlist, 'm3u'),
    })
    entries.push({
      type: 'item',
      id: 'export-csv',
      label: t('playlist.exportCsv'),
      icon: 'table',
      disabled: !hasSongs,
      onSelect: () => void handleMenuExport(playlist, 'csv'),
    })
    entries.push({ type: 'divider', id: 'divider-delete' })
    entries.push({
      type: 'item',
      id: 'delete',
      label: t('localPlaylist.delete'),
      icon: 'delete_outline',
      danger: true,
      onSelect: () => setConfirmDelete(true),
    })
    setContextMenu({ x: e.clientX, y: e.clientY, entries })
  }

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
              <span className="material-symbols-outlined text-sm">add</span>
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

          <ul className={playlistListClass}>
            {playlists.length === 0 && (
              <li className={playlistEmptyClass}>{t('localPlaylist.empty')}</li>
            )}
            {playlists.map((p, i) => {
              const entered = enteredIds.has(p.id)
              return (
                <li
                  key={p.id}
                  className={playlistRowAnimationClass(false, entered)}
                  style={entered ? undefined : { animationDelay: `${Math.min(i, 15) * 24}ms` }}
                  onAnimationEnd={(e) => {
                    if (e.target === e.currentTarget) markEntered(p.id)
                  }}
                >
                  {renamingId === p.id ? (
                    <div className={playlistRenameRowClass}>
                      <CoverImage
                        src={p.coverUrl}
                        alt={p.name}
                        size="sm"
                        fallbackIcon="queue_music"
                      />
                      <input
                        ref={inlineRenameInputRef}
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleInlineRename()
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={handleInlineBlur}
                        placeholder={t('localPlaylist.namePlaceholder')}
                        className={playlistRenameInputClass}
                      />
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        // 双击的第二次 click（detail=2）交给 onDoubleClick 处理
                        if (e.detail === 2) return
                        handleSelect(p.id)
                      }}
                      onDoubleClick={() => {
                        log.info('local-playlist.rename-inline', '双击行内重命名本地歌单', {
                          id: p.id,
                        })
                        setRenameDraft(p.name)
                        setRenamingId(p.id)
                      }}
                      onContextMenu={(e) => handleRowContextMenu(e, p)}
                      className={playlistRowClass(activeId === p.id)}
                    >
                      <CoverImage
                        src={p.coverUrl}
                        alt={p.name}
                        size="sm"
                        fallbackIcon="queue_music"
                      />
                      <MarqueeText text={p.name} className={playlistNameClass} />
                      <span className="flex shrink-0 items-center gap-1">
                        {(p.sources ?? []).map((source) => {
                          const meta = platforms.find((m) => m.id === source.platform)
                          return (
                            <span
                              key={`${source.platform}:${source.playlistId}`}
                              title={meta?.name ?? source.platform}
                            >
                              <PlatformLogo
                                platform={source.platform}
                                name={meta?.name ?? source.platform}
                                icon={meta?.icon ?? 'cloud'}
                                size="h-4 w-4"
                                iconSize="text-sm"
                              />
                            </span>
                          )
                        })}
                        <span className={playlistCountClass}>{p.songCount}</span>
                      </span>
                    </button>
                  )}
                </li>
              )
            })}
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
                  onBlur={handleHeaderBlur}
                  className="min-w-0 flex-1 border-0 border-b border-primary bg-transparent px-0 py-0.5 font-headline-lg text-headline-lg font-semibold text-on-surface outline-none"
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
                  <span className="material-symbols-outlined text-sm">sync_alt</span>
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
                          <PlatformLogo
                            platform={p.id}
                            name={p.name}
                            icon={p.icon}
                            size="h-4 w-4"
                            iconSize="text-sm"
                          />
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
            <div
              className="flex shrink-0 flex-col border-b border-outline-variant px-3 py-2"
              // 点击搜索面板外区域收起（relatedTarget 为焦点去向，仍在容器内则不收起）
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setSearchOpen(false)
                }
              }}
            >
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  {loggedPlatforms.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setSearchPlatform(p.id)
                        setSearchResults(null)
                        setSearchInput('')
                        setSearchHasMore(false)
                        setAddedSongIds(new Set())
                        searchPageRef.current = 1
                      }}
                      title={p.name}
                      className={`rounded-md p-1 transition-colors ${
                        searchPlatform === p.id
                          ? 'bg-primary/15 text-primary'
                          : 'text-outline hover:text-on-surface'
                      }`}
                    >
                      <PlatformLogo platform={p.id} name={p.name} icon={p.icon} />
                    </button>
                  ))}
                </div>
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onFocus={() => setSearchOpen(true)}
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

              {/* 搜索结果候选区：与歌单歌曲清单复用 SongList（行号/分页/三态添加按钮） */}
              {searchOpen && searchResults !== null && (
                <div className="mt-2">
                  <SongSearchResults
                    songs={searchResults}
                    hasMore={searchHasMore}
                    loadingMore={searchLoadingMore}
                    addingIds={addingIds}
                    addedIds={addedSongIds}
                    onAdd={(s) => void handleAddSong(s)}
                    onLoadMore={() => void loadMoreSearch()}
                    emptyText={t('localPlaylist.noResults')}
                    maxHeightClass="max-h-52"
                  />
                </div>
              )}
            </div>

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
                  key={activeId ?? 'none'}
                  songs={songs.map((s) => ({
                    id: String(s.id),
                    title: s.title,
                    artist: s.artist ?? '',
                    album: s.album,
                    durationMs: s.durationMs,
                    coverUrl: s.coverUrl,
                  }))}
                  showIndex
                  showHeader
                  selectable
                  onRemoveSelected={(ids) => handleRemoveSongs(ids.map(Number))}
                  renderAction={(song) => (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleRemoveSongs([Number(song.id)])
                      }}
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

      {contextMenu && (
        <ContextMenu
          open
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel={t('localPlaylist.menuLabel')}
          entries={contextMenu.entries}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
