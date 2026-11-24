import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type {
  PlatformAccount,
  PlatformMeta,
  PlatformPlaylist,
  PlatformSong,
} from '@core/models/platform'
import type { MatchQuery } from '@core/models/match'
import type { PendingConfirmSession, SyncTaskRecord } from '@core/models/sync'
import { MANUAL_REFRESH_MIN_INTERVAL_MS } from '@core/cachePolicy'
import { toM3u } from '@core/export/toM3u'
import { toCsv } from '@core/export/toCsv'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import { useSyncRunner } from '../sync/useSyncRunner'
import { songDupKey } from '../sync/helpers'
import SongList from './SongList'
import PlatformLogo from './PlatformLogo'
import LocalPlaylistPanel from './LocalPlaylistPanel'
import ProgressBar from './ProgressBar'
import LoadMoreSentinel from './LoadMoreSentinel'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import { notify } from './toast'

const log = createRendererLogger('renderer.playlist')

/** 歌单列表滚动分页大小 */
const PLAYLIST_PAGE_SIZE = 200
/** 歌曲列表滚动分页大小 */
const SONG_PAGE_SIZE = 200

interface PlaylistSectionProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  searchQuery: string
  /** 同步任务记录上报（同步中心展示与持久化） */
  onTaskUpdate: (task: SyncTaskRecord) => void
  /** 待确认会话（App 层持有，选择流程由 ConfirmSyncDialog 完成） */
  pendingConfirm: PendingConfirmSession | null
  onPendingConfirmChange: (session: PendingConfirmSession | null) => void
}

/** 歌单封面：缺省或加载失败回退音符图标 */
function PlaylistCover({ playlist }: { playlist: PlatformPlaylist }) {
  const [failed, setFailed] = useState(false)
  if (!playlist.coverUrl || failed) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-outline">
        <span className="material-symbols-outlined text-base">queue_music</span>
      </span>
    )
  }
  return (
    <img
      src={playlist.coverUrl}
      alt={playlist.name}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-md object-cover"
    />
  )
}

/** 超长文本：默认省略号截断，悬浮时自动来回滚动展示全文。
 *  外层是 flex 裁剪容器（overflow-hidden 挡住滚动文字，不溢出到封面/数字），
 *  内层 block 做省略号与 translateX 动画；flex 布局避免 inline-block 基线空隙。 */
function MarqueeText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  const [duration, setDuration] = useState(6)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const distance = Math.max(0, el.scrollWidth - el.clientWidth)
      setShift(distance)
      // 单程约 50px/s（滚动段占动画 70%），总时长限制在 2.5s ~ 12s
      setDuration(Math.min(12, Math.max(2.5, distance / 17.5)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  const scrolling = hovered && shift > 0

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`flex min-w-0 items-center overflow-hidden ${className ?? ''}`}
    >
      <span
        ref={ref}
        className={`max-w-full whitespace-nowrap ${
          scrolling ? 'marquee-x' : 'overflow-hidden text-ellipsis'
        }`}
        style={
          scrolling
            ? {
                ['--marquee-shift' as string]: `-${shift}px`,
                animationDuration: `${duration}s`,
              }
            : undefined
        }
      >
        {text}
      </span>
    </span>
  )
}

export default function PlaylistSection({
  platforms,
  accounts,
  searchQuery,
  onTaskUpdate,
  pendingConfirm,
  onPendingConfirmChange,
}: PlaylistSectionProps) {
  const { t } = useI18n()
  const [active, setActive] = useState<string>('')

  // 平台列表动态变化时，校正当前选中的平台（'local' 为本地歌单标签，不参与校正）
  useEffect(() => {
    if (active !== 'local' && !platforms.some((p) => p.id === active)) {
      setActive(platforms[0]?.id ?? '')
    }
  }, [platforms, active])
  const [playlists, setPlaylists] = useState<PlatformPlaylist[]>([])
  const [playlistTotal, setPlaylistTotal] = useState(0)
  const [songs, setSongs] = useState<PlatformSong[]>([])
  const [songTotal, setSongTotal] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 滚动分页加载防重入（歌单/歌曲共用）
  const loadingMoreRef = useRef(false)
  const [refreshing, setRefreshing] = useState(false)
  // 手动刷新冷却倒计时（秒）：与主进程限流阈值同口径，防连点触发平台风控
  const [refreshCooldown, setRefreshCooldown] = useState(0)
  const [error, setError] = useState<string>('')

  // --- 歌单选择与右键菜单 ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{
    x: number
    y: number
    entries: ContextMenuEntry[]
  } | null>(null)
  // 拖拽框选：mousedown 记录锚点，移动超阈值后进入框选，行 mouseenter 扩展范围
  const dragRef = useRef<{ anchorId: string; startX: number; startY: number; moved: boolean } | null>(
    null,
  )
  const suppressClickRef = useRef(false)

  // --- 跨平台歌单同步状态（gathering 为拉取源歌单歌曲阶段） ---
  const [gathering, setGathering] = useState(false)
  const { run, running: syncRunning, progress: syncProgress } = useSyncRunner()

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
  const [exportPicker, setExportPicker] = useState(false)

  const loggedIn = active !== '' && active !== 'local' && accounts[active] !== null
  const keyword = searchQuery.trim().toLowerCase()

  /** 当前平台是否声明写能力（歌单管理操作仅写平台可用） */
  const canManage = platforms.find((p) => p.id === active)?.capabilities.write === true
  const activePlaylist = playlists.find((p) => p.id === activeId)

  const visiblePlaylists = keyword
    ? playlists.filter((p) => p.name.toLowerCase().includes(keyword))
    : playlists

  const selectedPlaylists = playlists.filter((p) => selectedIds.has(p.id))
  const singlePlaylist = selectedPlaylists.length === 1 ? selectedPlaylists[0] : null

  /** 拖拽框选：锚点行到结束行（含）之间的可见行 */
  const selectRange = (anchorId: string, endId: string): Set<string> => {
    const idxA = visiblePlaylists.findIndex((p) => p.id === anchorId)
    const idxB = visiblePlaylists.findIndex((p) => p.id === endId)
    if (idxA === -1 || idxB === -1) return new Set([anchorId])
    const [from, to] = idxA < idxB ? [idxA, idxB] : [idxB, idxA]
    return new Set(visiblePlaylists.slice(from, to + 1).map((p) => p.id))
  }

  const handleRowMouseDown = (e: ReactMouseEvent, id: string) => {
    if (e.button !== 0) return
    dragRef.current = { anchorId: id, startX: e.clientX, startY: e.clientY, moved: false }
  }

  const handleRowMouseEnter = (id: string) => {
    const drag = dragRef.current
    if (!drag || !drag.moved) return
    setSelectedIds(selectRange(drag.anchorId, id))
  }
  const sourceName = platforms.find((p) => p.id === active)?.name ?? active
  /** 右键可同步到的目标平台：写能力 + 已登录 + 非源平台 */
  const syncTargets = platforms.filter(
    (p) => p.capabilities.write && p.id !== active && accounts[p.id] !== null,
  )

  const fetchPlaylists = useCallback(
    async (force = false) => {
      if (!loggedIn) return
      setLoading(true)
      setError('')
      try {
        const res = await window.electronAPI.platforms.userPlaylistsPage(
          active,
          0,
          PLAYLIST_PAGE_SIZE,
          force,
        )
        if (res.throttled) {
          notify('warning', t('playlist.refreshThrottled'))
        }
        log.info('playlist.list.fetch', '拉取歌单列表第一页', {
          platform: active,
          count: res.items.length,
          total: res.total,
          fromCache: res.fromCache,
          force,
        })
        setPlaylists(res.items)
        setPlaylistTotal(res.total)
        playlistsPlatformRef.current = active
        // 刷新后剔除已不存在的选择
        setSelectedIds((prev) => {
          const ids = new Set(res.items.map((p) => p.id))
          const next = new Set([...prev].filter((id) => ids.has(id)))
          return next.size === prev.size ? prev : next
        })
      } catch (e) {
        log.error('playlist.list.fetch-failed', '拉取歌单列表失败', e, { platform: active })
        setError(e instanceof Error ? e.message : t('playlist.fetchFailed'))
      } finally {
        setLoading(false)
      }
    },
    [active, loggedIn, t],
  )

  /** 滚动到底部时加载下一页歌单 */
  const loadMorePlaylists = async () => {
    if (!loggedIn || loadingMoreRef.current) return
    loadingMoreRef.current = true
    try {
      const res = await window.electronAPI.platforms.userPlaylistsPage(
        active,
        playlists.length,
        PLAYLIST_PAGE_SIZE,
      )
      setPlaylists((prev) => {
        const known = new Set(prev.map((p) => p.id))
        return [...prev, ...res.items.filter((p) => !known.has(p.id))]
      })
      setPlaylistTotal(res.total)
      log.debug('playlist.list.load-more', '加载更多歌单', {
        platform: active,
        loaded: playlists.length + res.items.length,
        total: res.total,
      })
    } catch (e) {
      log.error('playlist.list.load-more-failed', '加载更多歌单失败', e, { platform: active })
    } finally {
      loadingMoreRef.current = false
    }
  }

  // 各平台上次打开的歌单 id：切回平台时恢复上次选择，而非重新打开第一个
  const lastOpenedRef = useRef<Record<string, string>>({})
  // 已执行自动打开的「平台 → 歌单 id」：防止列表分页/刷新时重复触发
  const autoOpenedRef = useRef<Record<string, string>>({})
  // 当前歌单列表所属平台：防止切换平台瞬间用旧列表误打开
  const playlistsPlatformRef = useRef('')

  useEffect(() => {
    setPlaylists([])
    setPlaylistTotal(0)
    setSongs([])
    setSongTotal(0)
    setActiveId(null)
    setSelectedIds(new Set())
    setMenu(null)
    autoOpenedRef.current = {}
    void fetchPlaylists()
  }, [fetchPlaylists])

  // 拖拽框选：全局监听移动/抬起，移动超阈值即进入框选
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag || drag.moved) return
      if (Math.abs(e.clientX - drag.startX) > 5 || Math.abs(e.clientY - drag.startY) > 5) {
        drag.moved = true
        setSelectedIds(new Set([drag.anchorId]))
      }
    }
    const onUp = () => {
      const wasDrag = dragRef.current?.moved ?? false
      dragRef.current = null
      if (wasDrag) {
        // 拖拽结束后在同一行释放会触发 click，先抑制一次打开行为
        suppressClickRef.current = true
        setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 手动刷新冷却倒计时
  useEffect(() => {
    if (refreshCooldown <= 0) return
    const timer = setInterval(() => setRefreshCooldown((s) => s - 1), 1000)
    return () => clearInterval(timer)
  }, [refreshCooldown])

  const handleRefresh = async () => {
    if (refreshCooldown > 0 || refreshing || syncRunning) return
    log.info('playlist.list.refresh', '手动强制刷新歌单列表', { platform: active })
    setRefreshing(true)
    setRefreshCooldown(Math.ceil(MANUAL_REFRESH_MIN_INTERVAL_MS / 1000))
    await fetchPlaylists(true)
    setRefreshing(false)
  }

  const openPlaylist = useCallback(
    async (id: string) => {
      // 记录该平台最后打开的歌单，切回时恢复
      lastOpenedRef.current[active] = id
      setActiveId(id)
      setLoading(true)
      setError('')
      // 切换歌单时重置管理操作状态
      setRenaming(false)
      setConfirmDelete(false)
      setSearchResults(null)
      setSearchInput('')
      try {
        const res = await window.electronAPI.platforms.playlistSongsPage(active, id, 0, SONG_PAGE_SIZE)
        log.info('playlist.songs.fetch', '拉取歌单歌曲第一页', {
          platform: active,
          playlistId: id,
          count: res.items.length,
          total: res.total,
          fromCache: res.fromCache,
        })
        setSongs(res.items)
        setSongTotal(res.total)
      } catch (e) {
        log.error('playlist.songs.fetch-failed', '拉取歌曲失败', e, { platform: active, playlistId: id })
        setError(e instanceof Error ? e.message : t('playlist.fetchSongsFailed'))
      } finally {
        setLoading(false)
      }
    },
    [active, t],
  )

  // 歌单列表加载完成后自动打开详情：该平台首次访问打开第一个，曾打开过则恢复上次选择
  useEffect(() => {
    if (loading || playlists.length === 0) return
    if (playlistsPlatformRef.current !== active) return
    const remembered = lastOpenedRef.current[active]
    const targetId =
      remembered && playlists.some((p) => p.id === remembered) ? remembered : playlists[0].id
    if (autoOpenedRef.current[active] === targetId) return
    autoOpenedRef.current[active] = targetId
    void openPlaylist(targetId)
  }, [loading, playlists, openPlaylist, active])

  /** 滚动到底部时加载下一页歌曲 */
  const loadMoreSongs = async () => {
    if (!activeId || loadingMoreRef.current) return
    loadingMoreRef.current = true
    try {
      const res = await window.electronAPI.platforms.playlistSongsPage(
        active,
        activeId,
        songs.length,
        SONG_PAGE_SIZE,
      )
      setSongs((prev) => {
        const known = new Set(prev.map((s) => s.id))
        return [...prev, ...res.items.filter((s) => !known.has(s.id))]
      })
      setSongTotal(res.total)
      log.debug('playlist.songs.load-more', '加载更多歌曲', {
        platform: active,
        playlistId: activeId,
        loaded: songs.length + res.items.length,
        total: res.total,
      })
    } catch (e) {
      log.error('playlist.songs.load-more-failed', '加载更多歌曲失败', e, {
        platform: active,
        playlistId: activeId,
      })
    } finally {
      loadingMoreRef.current = false
    }
  }

  // --- 歌单选择 ---

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  /** 右键行：未选中则单选该行，构建菜单条目后在鼠标位置弹出（无可选操作则不弹） */
  const handleRowContextMenu = (e: ReactMouseEvent, playlist: PlatformPlaylist) => {
    e.preventDefault()
    log.debug('playlist.context-menu', '打开歌单右键菜单', { playlistId: playlist.id })
    const alreadySelected = selectedIds.has(playlist.id)
    if (!alreadySelected) {
      setSelectedIds(new Set([playlist.id]))
    }
    // 右键后该行是否单选：未选中将单选；已选中时保持当前选择规模
    const single = !alreadySelected || selectedIds.size === 1 ? playlist : null

    const entries: ContextMenuEntry[] = []
    const pushDivider = () => {
      const last = entries[entries.length - 1]
      if (last && last.type === 'item') {
        entries.push({ type: 'divider', id: `divider-${entries.length}` })
      }
    }
    if (single && canManage) {
      entries.push({
        type: 'item',
        id: 'rename',
        label: t('playlist.rename'),
        icon: 'edit',
        onSelect: handleMenuRename,
      })
    }
    if (single && canManage && syncTargets.length > 0) pushDivider()
    for (const p of syncTargets) {
      entries.push({
        type: 'item',
        id: `sync-${p.id}`,
        label: t('playlist.syncToPlatform', { platform: p.name }),
        iconNode: <PlatformLogo platform={p.id} name={p.name} icon={p.icon} size="h-4 w-4" />,
        onSelect: () => void handleSyncTo(p.id),
      })
    }
    if (syncTargets.length > 0 && (single?.appUrl ?? single?.webUrl)) pushDivider()
    if (single?.appUrl) {
      entries.push({
        type: 'item',
        id: 'open-app',
        label: t('playlist.openInApp', { platform: sourceName }),
        icon: 'open_in_new',
        onSelect: () => void handleOpenUrl(single.appUrl as string),
      })
    }
    if (single?.webUrl) {
      entries.push({
        type: 'item',
        id: 'open-web',
        label: t('playlist.openInBrowser'),
        icon: 'public',
        onSelect: () => void handleOpenUrl(single.webUrl as string),
      })
    }
    // 清理尾部分隔线；无任何可操作项时不弹菜单
    while (entries.length > 0 && entries[entries.length - 1].type === 'divider') entries.pop()
    if (!entries.some((entry) => entry.type === 'item')) return
    setMenu({ x: e.clientX, y: e.clientY, entries })
  }

  /** 右键重命名：目标歌单未激活时先激活，再进入头部内联编辑 */
  const handleMenuRename = () => {
    if (!singlePlaylist || !canManage) return
    void openPlaylist(singlePlaylist.id)
    setRenameDraft(singlePlaylist.name)
    setRenaming(true)
    setConfirmDelete(false)
  }

  const handleOpenUrl = async (url: string) => {
    try {
      await window.electronAPI.openExternal(url)
    } catch (e) {
      log.error('playlist.open-external-failed', '打开外部链接失败', e, {
        platform: active,
      })
      notify(
        'error',
        t('playlist.openFailed', { reason: e instanceof Error ? e.message : 'unknown' }),
      )
    }
  }

  // --- 歌单管理操作 ---

  const startRename = () => {
    if (!activePlaylist) return
    setRenameDraft(activePlaylist.name)
    setRenaming(true)
    setConfirmDelete(false)
  }

  /** 导出当前平台歌单为 m3u/csv 文件 */
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
      log.info('playlist.exported', '歌单已导出', { platform: active, format, saved })
      if (saved) notify('success', t('playlist.exported'), saved)
    } catch (e) {
      log.error('playlist.export-failed', '导出失败', e, { platform: active })
      notify('error', t('playlist.exportFailed'))
    }
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
      setPlaylistTotal((total) => Math.max(0, total - 1))
      setSongs([])
      setSongTotal(0)
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
      setSongTotal((total) => Math.max(0, total - 1))
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
      if (!songs.some((s) => s.id === song.id)) {
        setSongTotal((total) => total + 1)
      }
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

  // --- 跨平台歌单同步 ---

  /** 把所选歌单的歌曲同步到目标平台（拉歌 → 建任务 → 进度/选择/结果，进度收敛由 useSyncRunner 完成） */
  const handleSyncTo = async (targetPlatform: string) => {
    const selected = playlists.filter((p) => selectedIds.has(p.id))
    if (selected.length === 0 || gathering || syncRunning || pendingConfirm !== null) return
    const targetMeta = platforms.find((p) => p.id === targetPlatform)
    if (!targetMeta || accounts[targetPlatform] === null) {
      notify(
        'error',
        t('playlist.targetNotLoggedIn', { platform: targetMeta?.name ?? targetPlatform }),
      )
      return
    }
    log.info('playlist.sync-to', '从歌单发起跨平台同步', {
      sourcePlatform: active,
      targetPlatform,
      playlistIds: selected.map((p) => p.id),
    })
    setGathering(true)
    setError('')
    try {
      // 拉取所选歌单歌曲并去重
      const seen = new Set<string>()
      const queries: MatchQuery[] = []
      for (const p of selected) {
        const res = await window.electronAPI.platforms.playlistSongs(active, p.id)
        for (const s of res.data) {
          const key = songDupKey(s)
          if (seen.has(key)) continue
          seen.add(key)
          queries.push({ title: s.title, artist: s.artist })
        }
      }
      if (queries.length === 0) {
        notify('error', t('playlist.emptySyncSource'))
        return
      }

      const name =
        selected.length === 1
          ? selected[0].name
          : t('playlist.syncNameMultiple', { name: selected[0].name, count: selected.length })
      await run({
        targetPlatform,
        queries,
        name,
        source: 'playlist-import',
        onTaskUpdate,
        onPendingConfirmChange,
      })
    } catch (e) {
      log.error('playlist.sync-gather-failed', '拉取歌单歌曲失败', e, { sourcePlatform: active })
      notify('error', t('playlist.fetchSongsFailed'))
    } finally {
      setGathering(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0">
        <div className="flex w-fit gap-1 rounded-lg border border-outline-variant bg-surface-container-low p-1">
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
              <PlatformLogo platform={p.id} name={p.name} icon={p.icon} />
              {p.name}
            </button>
          ))}
          <button
            onClick={() => {
              log.info('playlist.platform-switch', '切换到本地歌单', { platform: 'local' })
              setActive('local')
            }}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-label-md text-label-md transition-colors ${
              active === 'local'
                ? 'bg-surface-container-highest text-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-base">save</span>
            {t('playlist.localTab')}
          </button>
        </div>
      </div>

      {active === 'local' ? (
        <LocalPlaylistPanel
          platforms={platforms}
          accounts={accounts}
          onTaskUpdate={onTaskUpdate}
          pendingConfirm={pendingConfirm}
          onPendingConfirmChange={onPendingConfirmChange}
        />
      ) : !loggedIn ? (
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
        <div className="mt-6 flex min-h-0 flex-1 gap-4">
          <div className="flex w-72 min-h-0 shrink-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-outline-variant bg-surface-container-low">
              <div className="flex shrink-0 items-center justify-between border-b border-outline-variant px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {t('playlist.listTitle')}
                  </span>
                  <button
                    onClick={() => void handleRefresh()}
                    disabled={refreshing || loading || refreshCooldown > 0}
                    title={
                      refreshCooldown > 0
                        ? t('playlist.refreshCooldown', { seconds: refreshCooldown })
                        : t('playlist.refresh')
                    }
                    className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary disabled:opacity-50"
                  >
                    <span
                      className={`material-symbols-outlined text-base ${refreshing ? 'animate-spin' : ''}`}
                    >
                      refresh
                    </span>
                  </button>
                </div>
                {selectedIds.size > 0 ? (
                  <div className="flex items-center gap-1">
                    <span className="font-label-mono text-label-mono text-primary">
                      {t('playlist.selectedCount', { count: selectedIds.size })}
                    </span>
                    <button
                      onClick={clearSelection}
                      title={t('playlist.clearSelection')}
                      className="flex items-center rounded-md p-0.5 text-outline transition-colors hover:bg-surface-container-highest hover:text-on-surface"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </div>
                ) : (
                  <span className="font-label-mono text-label-mono text-outline">
                    {playlists.length}
                  </span>
                )}
              </div>
              <ul className="min-h-0 flex-1 select-none space-y-0.5 overflow-y-auto p-1.5">
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
                {visiblePlaylists.map((p, i) => (
                  <li
                    key={p.id}
                    className="list-item-enter"
                    style={{ animationDelay: `${Math.min(i, 15) * 24}ms` }}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false
                          return
                        }
                        if (e.metaKey || e.ctrlKey) {
                          toggleSelect(p.id)
                          return
                        }
                        // 普通点击打开歌单时清空右键/框选产生的勾选状态
                        setSelectedIds(new Set())
                        void openPlaylist(p.id)
                      }}
                      onMouseDown={(e) => handleRowMouseDown(e, p.id)}
                      onMouseEnter={() => handleRowMouseEnter(p.id)}
                      onContextMenu={(e) => handleRowContextMenu(e, p)}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                        activeId === p.id
                          ? 'bg-primary-container/15 text-primary'
                          : selectedIds.has(p.id)
                            ? 'bg-primary/10 text-on-surface'
                            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      <PlaylistCover playlist={p} />
                      <MarqueeText
                        text={p.name}
                        className="min-w-0 flex-1 font-body-md text-body-md"
                      />
                      <span className="font-label-mono text-label-mono text-outline">
                        {p.songCount}
                      </span>
                    </div>
                  </li>
                ))}
                {playlists.length < playlistTotal && (
                  <li className="list-none">
                    <LoadMoreSentinel onVisible={() => void loadMorePlaylists()} />
                  </li>
                )}
              </ul>
            </div>

            {(gathering || syncRunning) && (
              <div className="mt-2 shrink-0 rounded-lg border border-outline-variant bg-surface-container-low p-2">
                {syncProgress ? (
                  <ProgressBar
                    ratio={syncProgress.ratio}
                    label={
                      <>
                        {syncProgress.stage === 'matching'
                          ? t('textCreator.matching')
                          : t('textCreator.adding')}{' '}
                        {Math.round(syncProgress.ratio * 100)}%
                      </>
                    }
                  />
                ) : (
                  <p className="flex items-center gap-1.5 font-label-sm text-label-sm text-on-surface-variant">
                    <span className="material-symbols-outlined animate-spin text-sm">
                      progress_activity
                    </span>
                    {t('playlist.syncGathering')}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-outline-variant bg-surface-container-low">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-outline-variant px-4 py-2">
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
                      <MarqueeText
                        text={activePlaylist?.name ?? ''}
                        className="min-w-0 font-label-sm text-label-sm text-on-surface-variant"
                      />
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
              </div>
              {activeId && (
                <div className="relative flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => setExportPicker((v) => !v)}
                    disabled={songs.length === 0}
                    title={t('playlist.export')}
                    className="flex items-center rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-primary disabled:opacity-50"
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
              )}
              {activeId && canManage && (
                <div className="flex shrink-0 items-center gap-2">
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
            {error && (
              <p className="shrink-0 px-4 py-2 font-label-sm text-label-sm text-error">{error}</p>
            )}
            {loading && (
              <p className="shrink-0 px-4 py-2 font-label-md text-label-md text-outline">
                {t('common.loading')}
              </p>
            )}
            {!loading && activeId && canManage && (
              <div className="shrink-0 border-b border-outline-variant px-4 py-2">
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
                  <div className="mt-2">
                    {searchResults.length === 0 ? (
                      <p className="rounded-md border border-outline-variant px-3 py-2 font-label-sm text-label-sm text-outline">
                        {t('playlist.noSearchResult')}
                      </p>
                    ) : (
                      <SongList
                        songs={searchResults}
                        showIndex={false}
                        maxHeightClass="max-h-64"
                        className="rounded-md border border-outline-variant"
                        renderAction={(s) => (
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
                        )}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
            {!loading && activeId && (
              <SongList
                songs={songs}
                className="min-h-0 flex-1"
                renderFooter={
                  songs.length < songTotal
                    ? () => <LoadMoreSentinel onVisible={() => void loadMoreSongs()} />
                    : undefined
                }
                renderAction={(s) =>
                  canManage ? (
                    <button
                      onClick={() => void handleRemoveSong(s.id)}
                      disabled={removingIds.has(s.id)}
                      title={t('playlist.removeSong')}
                      className="flex shrink-0 items-center rounded-md p-1 text-on-surface-variant opacity-0 transition-all hover:bg-error/10 hover:text-error group-hover:opacity-100 disabled:opacity-50"
                    >
                      <span
                        className={`material-symbols-outlined text-base ${removingIds.has(s.id) ? 'animate-spin' : ''}`}
                      >
                        {removingIds.has(s.id) ? 'progress_activity' : 'playlist_remove'}
                      </span>
                    </button>
                  ) : null
                }
              />
            )}
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu
          open
          x={menu.x}
          y={menu.y}
          ariaLabel={t('playlist.menuLabel')}
          entries={menu.entries}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
