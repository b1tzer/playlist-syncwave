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
import type { LocalPlaylist } from '@core/models/localPlaylist'
import type { MatchQuery } from '@core/models/match'
import type { PendingConfirmSession, SyncTaskRecord } from '@core/models/sync'
import { VISIBLE_REFRESH_CHECK_MS } from '@core/cachePolicy'
import { toM3u } from '@core/export/toM3u'
import { toCsv } from '@core/export/toCsv'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import { useSyncRunner } from '../sync/useSyncRunner'
import { songDupKey } from '../sync/helpers'
import SongList from './SongList'
import SongSearchResults from './SongSearchResults'
import PlatformLogo from './PlatformLogo'
import LocalPlaylistPanel from './LocalPlaylistPanel'
import ProgressBar from './ProgressBar'
import LoadMoreSentinel from './LoadMoreSentinel'
import ContextMenu, { type ContextMenuEntry } from './ContextMenu'
import Tooltip from './Tooltip'
import PlaylistList from './PlaylistList'
import PlaylistSelectionStatus from './PlaylistSelectionStatus'
import PlaylistDeleteDialog from './PlaylistDeleteDialog'
import { buildPlaylistMenuEntries } from './buildPlaylistMenu'
import { usePlaylistMultiSelect } from '../hooks/usePlaylistMultiSelect'
import { notify } from './toast'
import { notifyError } from '../utils/notifyError'
import { operationAllowed, operationReason } from '../utils/platformCapabilities'
import CoverImage from './CoverImage'

const log = createRendererLogger('renderer.playlist')

/** 歌单列表滚动分页大小 */
const PLAYLIST_PAGE_SIZE = 200
/** 歌曲列表滚动分页大小 */
const SONG_PAGE_SIZE = 200
/** 平台搜索单页大小：QQ 音乐单页上限 20，统一按 20 分页（各平台均支持） */
const SEARCH_PAGE_SIZE = 20
/** 拉取超过该时长未完成：待显示区域提示网络延迟（loading 结束自动复位） */
const SLOW_FETCH_THRESHOLD_MS = 3_000

interface PlaylistSectionProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  searchQuery: string
  /** 视图是否可见：隐藏视图暂停轮询与可见性刷新，避免后台重复 IPC */
  visible: boolean
  /** 同步任务记录上报（同步历史展示与持久化） */
  onTaskUpdate: (task: SyncTaskRecord) => void
  /** 待确认会话（App 层持有，选择流程由 ConfirmSyncDialog 完成） */
  pendingConfirm: PendingConfirmSession | null
  onPendingConfirmChange: (session: PendingConfirmSession | null) => void
}

export default function PlaylistSection({
  platforms,
  accounts,
  searchQuery,
  visible,
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
  /** 拉取超过阈值仍未完成：待显示区域提示网络延迟（转圈动效常驻） */
  const [slowLoading, setSlowLoading] = useState(false)

  // --- 缓存兜底 + 后台重新验证的行级更新 ---
  /** 后台重新验证后有变化的歌单行 id（行级高亮动画，结束后移除） */
  const [listFlashIds, setListFlashIds] = useState<Set<string>>(new Set())
  /** 后台重新验证后有变化的歌曲行 id（行级高亮动画，结束后移除） */
  const [songFlashIds, setSongFlashIds] = useState<Set<string>>(new Set())
  /** 当前歌单列表是否有数据：有缓存兜底时静默刷新，仅首次无数据时显示整区 loading */
  const playlistsRef = useRef<PlatformPlaylist[]>([])
  useEffect(() => {
    playlistsRef.current = playlists
  }, [playlists])
  /** 当前歌曲数据所属歌单：同歌单重开有缓存兜底，跨歌单切换才显示整区 loading */
  const songsPlaylistIdRef = useRef<string | null>(null)
  /** activeId 镜像：可见性刷新回调里读取当前歌单，避免闭包 stale */
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const clearListFlash = (id: string) => {
    setListFlashIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
  const clearSongFlash = (id: string) => {
    setSongFlashIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  // --- 右键菜单 ---
  const [menu, setMenu] = useState<{
    x: number
    y: number
    entries: ContextMenuEntry[]
  } | null>(null)

  // --- 跨平台歌单同步状态（gathering 为拉取源歌单歌曲阶段） ---
  const [gathering, setGathering] = useState(false)
  const { run, running: syncRunning, progress: syncProgress } = useSyncRunner()

  // --- 歌单管理操作状态 ---
  const [renameDraft, setRenameDraft] = useState('')
  /** 行内重命名：正在列表中原地编辑的歌单 id（右键重命名 / 双击行触发） */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const renameSubmittingRef = useRef(false)
  /** 右键新建歌单的内联表单 */
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const createSubmittingRef = useRef(false)

  /** 删除确认弹层目标歌单 */
  const [deleteTarget, setDeleteTarget] = useState<PlatformPlaylist | null>(null)
  /** 「保存到本地」选择弹层：待保存的平台歌单与可选本地歌单 */
  const [saveTarget, setSaveTarget] = useState<PlatformPlaylist | null>(null)
  const [localTargets, setLocalTargets] = useState<LocalPlaylist[]>([])

  // 保存到本地选择弹层：Escape 关闭
  useEffect(() => {
    if (!saveTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSaveTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveTarget])
  const [managing, setManaging] = useState(false)
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  /** 移除按钮悬浮即时提示（锚点 = 按钮底边中心，Tooltip 挂 body 显示） */
  const [removeTip, setRemoveTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [searchInput, setSearchInput] = useState('')
  /** 搜索面板展开（聚焦输入框展开，点击面板外收起） */
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<PlatformSong[] | null>(null)
  /** 搜索结果是否还有下一页（返回条数达到单页上限即视为有） */
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searchLoadingMore, setSearchLoadingMore] = useState(false)
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set())
  /** 本次会话中已添加成功的搜索歌曲（连同歌单已有歌曲标记「已添加」） */
  const [addedSongIds, setAddedSongIds] = useState<Set<string>>(new Set())
  const searchPageRef = useRef(1)
  const searchLoadingMoreRef = useRef(false)

  const loggedIn = active !== '' && active !== 'local' && accounts[active] !== null
  const keyword = searchQuery.trim().toLowerCase()

  const activeMeta = platforms.find((p) => p.id === active)
  /** 当前平台是否声明写能力（歌单管理操作仅写平台可用） */
  const canManage = activeMeta?.capabilities.write === true
  /** 操作级能力：不支持的操作置灰，悬浮显示原因（能力清单由平台适配器声明） */
  const canRename = operationAllowed(activeMeta, 'renamePlaylist')
  const canDelete = operationAllowed(activeMeta, 'deletePlaylist')
  const canCreatePlaylist = operationAllowed(activeMeta, 'createPlaylist')
  const canAddSongs = operationAllowed(activeMeta, 'addSongs')
  const canRemoveSong = operationAllowed(activeMeta, 'removeSongs')
  const removeSongReason = operationReason(activeMeta, 'removeSongs')

  const visiblePlaylists = keyword
    ? playlists.filter((p) => p.name.toLowerCase().includes(keyword))
    : playlists
  const {
    selectedIds,
    setSelectedIds,
    toggleSelect,
    clearSelection,
    handleRowMouseDown,
    handleRowMouseEnter,
    consumeSuppressedClick,
  } = usePlaylistMultiSelect(visiblePlaylists.map((p) => p.id))

  const sourceName = platforms.find((p) => p.id === active)?.name ?? active
  /** 右键可同步到的目标平台：已登录 + 非源平台 + 具备建单/加曲能力 */
  const syncTargets = platforms.filter(
    (p) =>
      p.id !== active &&
      accounts[p.id] !== null &&
      operationAllowed(p, 'createPlaylist') &&
      operationAllowed(p, 'addSongs'),
  )

  const fetchPlaylists = useCallback(
    async (force = false, silent = false) => {
      if (!loggedIn) return
      // 有缓存兜底时静默返回（不显示整区 loading），后台重新验证经事件推送行级更新
      if (playlistsRef.current.length === 0) setLoading(true)
      try {
        const res = await window.electronAPI.platforms.userPlaylistsPage(
          active,
          0,
          PLAYLIST_PAGE_SIZE,
          force,
          silent,
        )
        log.info('playlist.list.fetch', '拉取歌单列表第一页', {
          platform: active,
          count: res.items.length,
          total: res.total,
          fromCache: res.fromCache,
          stale: res.stale === true,
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
        notifyError(e, t('playlist.fetchFailed'))
      } finally {
        setLoading(false)
      }
    },
    [active, loggedIn, t],
  )

  // 歌单列表后台重新验证完成：整份数据替换 + 变化行行级高亮（不整区 loading、不动其他行）
  useEffect(() => {
    // preload 与渲染层版本不同步时（如 dev 下 preload 未重载）可选调用降级，避免白屏
    const off = window.electronAPI.platforms.onPlaylistsRefreshed?.((e) => {
      if (e.platform !== active) return
      // unchanged：主进程已刷新时间参数，无需动作；failed：保留缓存兜底，静默
      if (e.status !== 'updated' || !e.data) return
      log.info('playlist.list.refreshed', '歌单列表后台重新验证完成', {
        platform: e.platform,
        changed: e.changedIds?.length ?? 0,
        added: e.addedIds?.length ?? 0,
        removed: e.removedIds?.length ?? 0,
      })
      setPlaylists(e.data)
      setPlaylistTotal(e.data.length)
      const flash = new Set([...(e.changedIds ?? []), ...(e.addedIds ?? [])])
      if (flash.size > 0) setListFlashIds(flash)
      // 剔除已不存在的选择
      setSelectedIds((prev) => {
        const ids = new Set(e.data!.map((p) => p.id))
        const next = new Set([...prev].filter((id) => ids.has(id)))
        return next.size === prev.size ? prev : next
      })
    })
    return off ?? (() => {})
  }, [active])

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
    setRenamingId(null)
    setCreating(false)
    setCreateDraft('')
    setListFlashIds(new Set())
    setSongFlashIds(new Set())
    songsPlaylistIdRef.current = null
    autoOpenedRef.current = {}
    void fetchPlaylists()
  }, [fetchPlaylists])

  // 手动强制刷新：主进程等待真实请求完成才返回，期间按钮置灰，完成后恢复可点
  const handleRefresh = async () => {
    if (refreshing || syncRunning) return
    log.info('playlist.list.refresh', '手动强制刷新歌单列表', { platform: active })
    setRefreshing(true)
    await fetchPlaylists(true)
    setRefreshing(false)
  }

  const openPlaylist = useCallback(
    async (id: string) => {
      // 记录该平台最后打开的歌单，切回时恢复
      lastOpenedRef.current[active] = id
      setActiveId(id)
      // 跨歌单切换才显示整区 loading；同歌单重开有缓存兜底，静默返回后经事件行级更新
      if (songsPlaylistIdRef.current !== id) setLoading(true)
      // 切换歌单时重置管理操作状态与搜索会话
      setRenamingId(null)
      setSearchResults(null)
      setSearchInput('')
      setSearchHasMore(false)
      setSearchOpen(false)
      setAddedSongIds(new Set())
      searchPageRef.current = 1
      try {
        // 打开即静默强制重新验证一次（令牌桶约束，桶允许才请求接口）：先缓存兜底展示，
        // 后台验证完成后经事件推送行级更新
        const res = await window.electronAPI.platforms.playlistSongsPage(
          active,
          id,
          0,
          SONG_PAGE_SIZE,
          true,
          true,
        )
        log.info('playlist.songs.fetch', '拉取歌单歌曲第一页', {
          platform: active,
          playlistId: id,
          count: res.items.length,
          total: res.total,
          fromCache: res.fromCache,
          stale: res.stale === true,
        })
        songsPlaylistIdRef.current = id
        setSongs(res.items)
        setSongTotal(res.total)
      } catch (e) {
        log.error('playlist.songs.fetch-failed', '拉取歌曲失败', e, { platform: active, playlistId: id })
        notifyError(e, t('playlist.fetchSongsFailed'))
      } finally {
        setLoading(false)
      }
    },
    [active, t],
  )

  // --- 可见性驱动刷新：只在用户看得到的时候更新，显示与更新两条线 ---
  // 进入歌单页（挂载）、窗口重新聚焦、切回前台 → 静默强制重新验证一次（令牌桶约束）；
  // 打开期间每 VISIBLE_REFRESH_CHECK_MS 检查一次缓存是否过期（过期才请求接口）。
  const refreshVisible = useCallback(() => {
    if (!loggedIn) return
    log.debug('playlist.visible-refresh', '可见性驱动刷新', { platform: active })
    void fetchPlaylists(true, true)
    const playlistId = activeIdRef.current
    if (playlistId) {
      void window.electronAPI.platforms.playlistSongsPage(
        active,
        playlistId,
        0,
        SONG_PAGE_SIZE,
        true,
        true,
      )
    }
  }, [loggedIn, active, fetchPlaylists])

  const visibleRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!loggedIn || !visible) return
    // 挂载/切回页面/聚焦等连续触发 300ms 去抖合并为一次刷新
    const schedule = () => {
      if (visibleRefreshTimerRef.current) clearTimeout(visibleRefreshTimerRef.current)
      visibleRefreshTimerRef.current = setTimeout(() => {
        visibleRefreshTimerRef.current = null
        refreshVisible()
      }, 300)
    }
    schedule()
    // 打开期间定期检查：非强制，主进程按 TTL 判断（过期才请求接口，走令牌桶）
    const interval = setInterval(() => {
      void fetchPlaylists(false, true)
      const playlistId = activeIdRef.current
      if (playlistId) {
        void window.electronAPI.platforms.playlistSongsPage(
          active,
          playlistId,
          0,
          SONG_PAGE_SIZE,
          false,
          true,
        )
      }
    }, VISIBLE_REFRESH_CHECK_MS)
    const onFocus = () => schedule()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (visibleRefreshTimerRef.current) clearTimeout(visibleRefreshTimerRef.current)
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [loggedIn, visible, refreshVisible, fetchPlaylists])

  // 歌单歌曲后台重新验证完成：仅当前打开歌单生效，整份替换 + 变化行行级高亮
  useEffect(() => {
    // preload 与渲染层版本不同步时可选调用降级，避免白屏
    const off = window.electronAPI.platforms.onSongsRefreshed?.((e) => {
      if (e.platform !== active || e.playlistId !== activeId) return
      if (e.status !== 'updated' || !e.data) return
      log.info('playlist.songs.refreshed', '歌单歌曲后台重新验证完成', {
        platform: e.platform,
        playlistId: e.playlistId,
        changed: e.changedIds?.length ?? 0,
        added: e.addedIds?.length ?? 0,
        removed: e.removedIds?.length ?? 0,
      })
      setSongs(e.data)
      setSongTotal(e.data.length)
      const flash = new Set([...(e.changedIds ?? []), ...(e.addedIds ?? [])])
      if (flash.size > 0) setSongFlashIds(flash)
    })
    return off ?? (() => {})
  }, [active, activeId])

  // 拉取超过阈值仍未完成：待显示区域提示网络延迟并保持转圈动效，让用户明白还在获取中
  useEffect(() => {
    if (!loading) {
      setSlowLoading(false)
      return
    }
    const timer = setTimeout(() => setSlowLoading(true), SLOW_FETCH_THRESHOLD_MS)
    return () => clearTimeout(timer)
  }, [loading])

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

  const menuLabels = {
    create: t('playlist.create'),
    rename: t('playlist.rename'),
    syncToPlatform: (platform: string) => t('playlist.syncToPlatform', { platform }),
    exportM3u: t('playlist.exportM3u'),
    exportCsv: t('playlist.exportCsv'),
    delete: t('playlist.delete'),
  }
  const openCreateForm = () => {
    setCreating(true)
    setCreateDraft('')
  }

  /** 右键新建歌单：调用平台适配器建单并刷新列表 */
  const handleCreatePlaylist = async () => {
    const name = createDraft.trim()
    if (!name || createSubmittingRef.current) return
    createSubmittingRef.current = true
    try {
      const playlistId = await window.electronAPI.platforms.createPlaylist(active, name)
      setCreating(false)
      setCreateDraft('')
      await fetchPlaylists(true)
      log.info('playlist.create', '新建歌单完成', { platform: active, playlistId })
      notify('success', t('playlist.created'), t('playlist.createdDetail', { name }))
    } catch (e) {
      log.error('playlist.create-failed', '新建歌单失败', e, { platform: active })
      notifyError(e, t('playlist.createFailed'))
    } finally {
      createSubmittingRef.current = false
    }
  }

  /** 右键行：未选中则单选该行，构建菜单条目后在鼠标位置弹出（无可选操作则不弹） */
  const handleRowContextMenu = (e: ReactMouseEvent, playlist: PlatformPlaylist) => {
    e.preventDefault()
    e.stopPropagation()
    log.debug('playlist.context-menu', '打开歌单右键菜单', { playlistId: playlist.id })
    const alreadySelected = selectedIds.has(playlist.id)
    if (!alreadySelected) {
      setSelectedIds(new Set([playlist.id]))
    }
    // 右键后该行是否单选：未选中将单选；已选中时保持当前选择规模
    const single = !alreadySelected || selectedIds.size === 1 ? playlist : null
    // 同步范围在菜单构建时固化：右键未选中行时该行即将变为唯一选中，但 setSelectedIds
    // 是异步的，点击菜单项时闭包里的 selectedIds 仍是旧值（空集），同步会静默落空。
    // 必须把范围直接闭包进 onSelect，不能等到 handleSyncTo 里再读 state。
    const syncSelection = alreadySelected ? new Set(selectedIds) : new Set([playlist.id])

    const extraItems: ContextMenuEntry[] = []
    if (single?.appUrl) {
      const url = single.appUrl
      extraItems.push({
        type: 'item',
        id: 'open-app',
        label: t('playlist.openInApp', { platform: sourceName }),
        icon: 'open_in_new',
        onSelect: () => void handleOpenUrl(url),
      })
    }
    if (single?.webUrl) {
      const url = single.webUrl
      extraItems.push({
        type: 'item',
        id: 'open-web',
        label: t('playlist.openInBrowser'),
        icon: 'public',
        onSelect: () => void handleOpenUrl(url),
      })
    }
    if (single) {
      extraItems.push({
        type: 'item',
        id: 'save-local',
        label: t('playlist.saveToLocal'),
        icon: 'bookmark_add',
        onSelect: () => {
          setSaveTarget(single)
          void window.electronAPI.localPlaylists
            .list()
            .then(setLocalTargets)
            .catch((e: unknown) => {
              log.error('playlist.save-local-list-failed', '读取本地歌单列表失败', e)
              setLocalTargets([])
            })
        },
      })
    }
    const entries = buildPlaylistMenuEntries({
      playlist,
      single: single !== null,
      canRename,
      canDelete,
      syncTargets,
      syncSelection,
      createDisabled: !canCreatePlaylist || !loggedIn,
      labels: menuLabels,
      onCreate: openCreateForm,
      onRename: handleMenuRename,
      onSync: (targetId, selection) => void handleSyncTo(targetId, selection),
      onExport: (target, format) => void handleMenuExport(target, format),
      onDelete: (target) => setDeleteTarget(target),
      extraItems,
    })
    if (!entries.some((entry) => entry.type === 'item')) return
    setMenu({ x: e.clientX, y: e.clientY, entries })
  }

  /** 列表空白区右键：只提供新建歌单 */
  const handleBlankContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    log.debug('playlist.context-menu-blank', '打开列表空白区右键菜单', { platform: active })
    const entries = buildPlaylistMenuEntries({
      playlist: { id: '', name: '' },
      single: false,
      canRename: false,
      canDelete: false,
      syncTargets: [],
      syncSelection: new Set(),
      showCreate: true,
      createDisabled: !canCreatePlaylist || !loggedIn,
      labels: menuLabels,
      onCreate: openCreateForm,
    })
    if (!entries.some((entry) => entry.type === 'item')) return
    setMenu({ x: e.clientX, y: e.clientY, entries })
  }

  /** 双击歌单行进入内联重命名 */
  const handlePlaylistDoubleClick = (id: string) => {
    if (!canRename) return
    const playlist = visiblePlaylists.find((p) => p.id === id)
    if (!playlist) return
    log.info('playlist.rename-inline', '行内重命名歌单', {
      platform: active,
      playlistId: id,
    })
    setRenameDraft(playlist.name)
    setRenamingId(id)
  }

  /** 右键重命名：直接在歌单列表该行原地进入内联编辑 */
  const handleMenuRename = (playlist: PlatformPlaylist) => {
    if (!canRename) return
    log.info('playlist.rename-inline', '行内重命名歌单', {
      platform: active,
      playlistId: playlist.id,
    })
    setRenameDraft(playlist.name)
    setRenamingId(playlist.id)
  }

  const handleOpenUrl = async (url: string) => {
    try {
      await window.electronAPI.openExternal(url)
    } catch (e) {
      log.error('playlist.open-external-failed', '打开外部链接失败', e, {
        platform: active,
      })
      notifyError(e, t('playlist.openFailed'))
    }
  }

  // --- 歌单管理操作 ---

  /** 平台歌单保存到本地：新建或增量合并到已有本地歌单 */
  const handleSaveToLocal = async (
    playlist: PlatformPlaylist,
    targetId?: string,
  ) => {
    log.info('playlist.save-local', '导出平台歌单到本地', {
      platform: active,
      playlistId: playlist.id,
      targetId,
    })
    setManaging(true)
    try {
      const result = await window.electronAPI.localPlaylists.importPlatformPlaylist(
        active,
        playlist,
        targetId,
      )
      if (!result) return
      setSaveTarget(null)
      log.info('playlist.saved-local', '平台歌单已保存到本地', {
        id: result.playlist.id,
        created: result.created,
        added: result.added,
        updated: result.updated,
      })
      if (result.created) {
        notify('success', t('playlist.savedToLocal'), result.playlist.name)
      } else {
        notify(
          'success',
          t('playlist.savedToLocalIncremental', {
            added: result.added,
            updated: result.updated,
          }),
          result.playlist.name,
        )
      }
    } catch (e) {
      log.error('playlist.save-local-failed', '保存到本地失败', e, { platform: active })
      notifyError(e, t('playlist.saveToLocalFailed'))
    } finally {
      setManaging(false)
    }
  }

  /** 右键导出歌单为 m3u/csv 文件（按需拉取该歌单歌曲） */
  const handleMenuExport = async (playlist: PlatformPlaylist, format: 'm3u' | 'csv') => {
    log.info('playlist.export', '右键导出歌单', { platform: active, playlistId: playlist.id, format })
    setManaging(true)
    try {
      const res = await window.electronAPI.platforms.playlistSongs(active, playlist.id)
      const exportSongs = res.data.map((s) => ({
        title: s.title,
        artist: s.artist || undefined,
        album: s.album,
        durationMs: s.durationMs,
      }))
      if (exportSongs.length === 0) {
        notify('warning', t('playlist.emptySyncSource'))
        return
      }
      const content = format === 'm3u' ? toM3u(exportSongs) : toCsv(exportSongs)
      const saved = await window.electronAPI.saveTextFile(playlist.name, content, format)
      log.info('playlist.exported', '歌单已导出', { platform: active, format, saved })
      if (saved) notify('success', t('playlist.exported'), saved)
    } catch (e) {
      log.error('playlist.export-failed', '导出失败', e, { platform: active })
      notify('error', t('playlist.exportFailed'))
    } finally {
      setManaging(false)
    }
  }

  /** 提交重命名：头部编辑与行内编辑共用 */
  const submitRename = async (id: string | null): Promise<boolean> => {
    const name = renameDraft.trim()
    if (!name || !id || renameSubmittingRef.current) return false
    renameSubmittingRef.current = true
    log.info('playlist.rename', '重命名歌单', { platform: active, playlistId: id })
    setManaging(true)
    try {
      await window.electronAPI.platforms.renamePlaylist(active, id, name)
      setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)))
      return true
    } catch (e) {
      log.error('playlist.rename-failed', '重命名失败', e, { platform: active, playlistId: id })
      notifyError(e, t('playlist.renameFailed'))
      return false
    } finally {
      setManaging(false)
      renameSubmittingRef.current = false
    }
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

  /** 右键删除歌单：确认弹层通过后执行 */
  const handleMenuDelete = async () => {
    const playlist = deleteTarget
    if (!playlist || !canDelete) return
    log.info('playlist.delete', '删除歌单', { platform: active, playlistId: playlist.id })
    setManaging(true)
    try {
      await window.electronAPI.platforms.deletePlaylist(active, playlist.id)
      setPlaylists((prev) => prev.filter((p) => p.id !== playlist.id))
      setPlaylistTotal((total) => Math.max(0, total - 1))
      // 删除的是当前打开的歌单时清空右侧歌曲区
      if (activeId === playlist.id) {
        setSongs([])
        setSongTotal(0)
        setActiveId(null)
        setSearchResults(null)
        setSearchHasMore(false)
        setSearchOpen(false)
        setAddedSongIds(new Set())
        searchPageRef.current = 1
        songsPlaylistIdRef.current = null
      }
      setDeleteTarget(null)
    } catch (e) {
      log.error('playlist.delete-failed', '删除歌单失败', e, {
        platform: active,
        playlistId: playlist.id,
      })
      notifyError(e, t('playlist.deleteFailed'))
    } finally {
      setManaging(false)
    }
  }

  /** 批量移除歌曲（行内单曲删除与列表多选删除共用） */
  const handleRemoveSongs = async (songIds: string[]): Promise<boolean> => {
    if (!activeId || songIds.length === 0) return false
    log.info('playlist.remove-song', '从歌单移除歌曲', {
      platform: active,
      playlistId: activeId,
      songIds,
    })
    setRemovingIds((prev) => new Set([...prev, ...songIds]))
    try {
      await window.electronAPI.platforms.removeSongsFromPlaylist(active, activeId, songIds)
      const removed = new Set(songIds)
      setSongs((prev) => prev.filter((s) => !removed.has(s.id)))
      setSongTotal((total) => Math.max(0, total - songIds.length))
      // 歌单列表卡片数字即时扣减（主进程已标记缓存失效，后台重新验证后以平台数据为准）
      setPlaylists((prev) =>
        prev.map((p) =>
          p.id === activeId && p.songCount !== undefined
            ? { ...p, songCount: Math.max(0, p.songCount - songIds.length) }
            : p,
        ),
      )
      return true
    } catch (e) {
      log.error('playlist.remove-song-failed', '移除歌曲失败', e, {
        platform: active,
        playlistId: activeId,
        songIds,
      })
      // 行内操作失败用右上角 toast 提示，代码性报错不展示给用户
      notifyError(e, t('playlist.removeSongFailed'))
      return false
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev)
        for (const id of songIds) next.delete(id)
        return next
      })
    }
  }

  const handleSearch = async (page = 1) => {
    const kw = searchInput.trim()
    if (!kw) return
    const isFirstPage = page === 1
    if (isFirstPage) {
      log.info('playlist.search-songs', '搜索歌曲', { platform: active, keyword: kw })
      setSearching(true)
    } else {
      setSearchLoadingMore(true)
    }
    try {
      const results = await window.electronAPI.platforms.searchSongs(
        active,
        kw,
        SEARCH_PAGE_SIZE,
        page,
      )
      searchPageRef.current = page
      setSearchResults((prev) => (isFirstPage ? results : [...(prev ?? []), ...results]))
      // 返回达到单页上限即视为可能还有下一页（滚动到底继续加载，多余一次空请求无害）
      setSearchHasMore(results.length === SEARCH_PAGE_SIZE)
      setSearchOpen(true)
    } catch (e) {
      log.error('playlist.search-failed', '搜索歌曲失败', e, { platform: active, keyword: kw })
      notifyError(e, t('playlist.searchFailedHint'))
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
    if (!activeId) return
    log.info('playlist.add-song', '添加歌曲到歌单', {
      platform: active,
      playlistId: activeId,
      songId: song.id,
    })
    setAddingIds((prev) => new Set(prev).add(song.id))
    try {
      await window.electronAPI.platforms.addSongsToPlaylist(active, activeId, [song.id])
      // 添加成功：结果行保留并标记「已添加」，不再从结果里移除
      setAddedSongIds((prev) => new Set(prev).add(song.id))
      const isNew = !songs.some((s) => s.id === song.id)
      setSongs((prev) => (isNew ? [...prev, song] : prev))
      if (isNew) {
        setSongTotal((total) => total + 1)
        // 歌单列表卡片数字即时 +1（主进程已标记缓存失效，后台重新验证后以平台数据为准）
        setPlaylists((prev) =>
          prev.map((p) =>
            p.id === activeId && p.songCount !== undefined
              ? { ...p, songCount: p.songCount + 1 }
              : p,
          ),
        )
      }
    } catch (e) {
      log.error('playlist.add-song-failed', '添加歌曲失败', e, {
        platform: active,
        playlistId: activeId,
        songId: song.id,
      })
      notifyError(e, t('playlist.addSongFailed'))
    } finally {
      setAddingIds((prev) => {
        const next = new Set(prev)
        next.delete(song.id)
        return next
      })
    }
  }

  // --- 跨平台歌单同步 ---

  /**
   * 把所选歌单的歌曲同步到目标平台（拉歌 → 建任务 → 进度/选择/结果，进度收敛由 useSyncRunner 完成）。
   * syncIds 由右键菜单构建时固化传入：点击菜单项时 state 里的 selectedIds 可能与右键时刻不一致
   * （右键未选中行会异步变为唯一选中），读 state 会把同步范围算成空集。
   */
  const handleSyncTo = async (targetPlatform: string, syncIds: Set<string>) => {
    const selected = playlists.filter((p) => syncIds.has(p.id))
    if (selected.length === 0) {
      notify('error', t('playlist.syncNoSelection'))
      return
    }
    if (gathering || syncRunning || pendingConfirm !== null) return
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
              <PlatformLogo
                platform={p.id}
                name={p.name}
                icon={p.icon}
                size="h-4 w-4"
                iconSize="text-sm"
              />
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
            <span className="material-symbols-outlined text-sm">save</span>
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
            {platforms.length === 0
              ? t('playlist.noPlatformHint')
              : t('playlist.loginHint', {
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
                <PlaylistSelectionStatus
                  count={selectedIds.size}
                  total={playlists.length}
                  onClear={clearSelection}
                />
              </div>
              <PlaylistList
                key={active}
                items={visiblePlaylists}
                activeId={activeId}
                selectedIds={selectedIds}
                renamingId={renamingId}
                renameDraft={renameDraft}
                renamePlaceholder={t('playlist.renamePlaceholder')}
                emptyText={keyword ? t('playlist.noMatch') : t('playlist.empty')}
                loading={loading && playlists.length === 0}
                loadingText={slowLoading ? t('playlist.slowFetch') : t('common.loading')}
                renameDisabled={managing}
                flashIds={listFlashIds}
                onFlashEnd={clearListFlash}
                onOpen={(id) => {
                  setSelectedIds(new Set())
                  void openPlaylist(id)
                }}
                onToggleSelect={toggleSelect}
                onDoubleClick={handlePlaylistDoubleClick}
                onMouseDown={handleRowMouseDown}
                onMouseEnter={handleRowMouseEnter}
                onContextMenu={handleRowContextMenu}
                onBlankContextMenu={handleBlankContextMenu}
                onRenameChange={setRenameDraft}
                onRenameKeyDown={(e) => {
                  if (e.key === 'Enter') void handleInlineRename()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onRenameBlur={handleInlineBlur}
                creating={creating}
                createDraft={createDraft}
                createPlaceholder={t('playlist.createPlaceholder')}
                createLabel={t('playlist.create')}
                cancelLabel={t('playlist.cancel')}
                onCreateChange={setCreateDraft}
                onCreateSubmit={() => void handleCreatePlaylist()}
                onCreateCancel={() => {
                  setCreating(false)
                  setCreateDraft('')
                }}
                consumeSuppressedClick={consumeSuppressedClick}
                renderFooter={
                  playlists.length < playlistTotal
                    ? () => (
                        <li className="list-none">
                          <LoadMoreSentinel onVisible={() => void loadMorePlaylists()} />
                        </li>
                      )
                    : undefined
                }
              />
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
            {loading && (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 font-label-md text-label-md text-outline">
                <span className="material-symbols-outlined animate-spin text-xl">
                  progress_activity
                </span>
                {slowLoading ? t('playlist.slowFetch') : t('common.loading')}
              </div>
            )}
            {!loading && activeId && canAddSongs && (
              <div
                className="shrink-0 border-b border-outline-variant px-4 py-2"
                // 点击搜索面板外区域收起（relatedTarget 为焦点去向，仍在容器内则不收起）
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setSearchOpen(false)
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
                    <span className="material-symbols-outlined text-sm text-primary">
                      playlist_add
                    </span>
                    {t('playlist.addSongs')}
                  </span>
                  <input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onFocus={() => setSearchOpen(true)}
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
                      className={`material-symbols-outlined text-sm ${searching ? 'animate-spin' : ''}`}
                    >
                      {searching ? 'progress_activity' : 'search'}
                    </span>
                    {t('playlist.search')}
                  </button>
                </div>
                {searchOpen && searchResults && (
                  <div className="mt-2">
                    <SongSearchResults
                      songs={searchResults}
                      hasMore={searchHasMore}
                      loadingMore={searchLoadingMore}
                      addingIds={addingIds}
                      addedIds={
                        new Set([...addedSongIds, ...songs.map((s) => s.id)])
                      }
                      onAdd={(s) => void handleAddSong(s)}
                      onLoadMore={() => void loadMoreSearch()}
                      emptyText={t('playlist.noSearchResult')}
                    />
                  </div>
                )}
              </div>
            )}
            {!loading && activeId && (
              <SongList
                key={activeId}
                songs={songs}
                showHeader
                flashIds={songFlashIds}
                onFlashEnd={clearSongFlash}
                selectable={canManage}
                onRemoveSelected={handleRemoveSongs}
                removeDisabled={!canRemoveSong}
                removeDisabledReason={removeSongReason ?? t('playlist.removeSong')}
                className="min-h-0 flex-1"
                renderFooter={
                  songs.length < songTotal
                    ? () => <LoadMoreSentinel onVisible={() => void loadMoreSongs()} />
                    : undefined
                }
                renderAction={(s) =>
                  canManage ? (
                    // disabled 按钮不响应鼠标事件：悬浮事件挂在外层 span 上，
                    // 原生 title 延迟过久改用即时 Tooltip，按钮自身置灰
                    <span
                      className="flex shrink-0 items-center"
                      onClick={(e) => e.stopPropagation()}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setRemoveTip({
                          x: rect.left + rect.width / 2,
                          y: rect.bottom,
                          text: canRemoveSong
                            ? t('playlist.removeSong')
                            : (removeSongReason ?? t('playlist.removeSong')),
                        })
                      }}
                      onMouseLeave={() => setRemoveTip(null)}
                    >
                      <button
                        onClick={() => void handleRemoveSongs([s.id])}
                        disabled={!canRemoveSong || removingIds.has(s.id)}
                        aria-disabled={!canRemoveSong}
                        className="flex items-center rounded-md p-1 text-on-surface-variant opacity-0 transition-all group-hover:opacity-100 hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
                      >
                        <span
                          className={`material-symbols-outlined text-base ${removingIds.has(s.id) ? 'animate-spin' : ''}`}
                        >
                          {removingIds.has(s.id) ? 'progress_activity' : 'playlist_remove'}
                        </span>
                      </button>
                    </span>
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

      {removeTip && <Tooltip x={removeTip.x} y={removeTip.y} text={removeTip.text} />}

      {saveTarget && (
        <div
          className="dialog-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSaveTarget(null)}
        >
          <div
            className="dialog-panel-enter flex w-[28rem] max-w-full flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-headline-sm text-headline-sm font-semibold text-on-surface">
              {t('playlist.saveToLocalTitle')}
            </h3>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {t('playlist.saveToLocalHint')}
            </p>
            <button
              onClick={() => void handleSaveToLocal(saveTarget)}
              disabled={managing}
              className="flex items-center gap-2 rounded-lg border border-primary px-3 py-2 text-left font-label-md text-label-md text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">add</span>
              {t('playlist.saveToLocalNew')}
            </button>
            <p className="font-label-md text-label-md text-on-surface-variant">
              {t('playlist.saveToLocalExisting')}
            </p>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-outline-variant">
              {localTargets.length === 0 ? (
                <p className="px-3 py-4 text-center font-label-md text-label-md text-outline">
                  {t('localPlaylist.empty')}
                </p>
              ) : (
                localTargets.map((p) => {
                  const sources = p.sources ?? []
                  return (
                    <button
                      key={p.id}
                      onClick={() => void handleSaveToLocal(saveTarget, p.id)}
                      disabled={managing}
                      className="flex w-full items-center gap-2 border-b border-outline-variant px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-container-high disabled:opacity-40"
                    >
                      <CoverImage src={p.coverUrl} alt={p.name} size="sm" fallbackIcon="queue_music" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-label-md text-label-md text-on-surface">
                          {p.name}
                        </span>
                        <span className="flex items-center gap-1 font-label-sm text-label-sm text-on-surface-variant">
                          {sources.length > 0 ? (
                            sources.map((s) => {
                              const meta = platforms.find((m) => m.id === s.platform)
                              return (
                                <span
                                  key={`${s.platform}:${s.playlistId}`}
                                  title={`${t('playlist.saveToLocalSources')}: ${meta?.name ?? s.platform}`}
                                >
                                  <PlatformLogo
                                    platform={s.platform}
                                    name={meta?.name ?? s.platform}
                                    icon={meta?.icon ?? 'cloud'}
                                    size="h-4 w-4"
                                    iconSize="text-sm"
                                  />
                                </span>
                              )
                            })
                          ) : (
                            <span className="material-symbols-outlined text-sm">library_music</span>
                          )}
                          <span>{p.songCount}</span>
                        </span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setSaveTarget(null)}
                disabled={managing}
                className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-40"
              >
                {t('playlist.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      <PlaylistDeleteDialog
        name={deleteTarget?.name ?? null}
        busy={managing}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleMenuDelete()}
      />
    </div>
  )
}
