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
import type {
  PendingConfirmSession,
  SyncFailedItem,
  SyncItemResult,
  SyncTaskRecord,
} from '@core/models/sync'
import { normalize } from '@core/matcher/matchSong'
import { MANUAL_REFRESH_MIN_INTERVAL_MS } from '@core/cachePolicy'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import SongList from './SongList'
import { PLATFORM_LOGOS } from './platformLogos'
import { notify } from './toast'

const log = createRendererLogger('renderer.playlist')

/** 歌曲去重键：标题+歌手归一化（与匹配引擎同口径） */
const songDupKey = (s: { title: string; artist?: string }): string =>
  `${normalize(s.title)}|${normalize(s.artist ?? '')}`

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high'

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

export default function PlaylistSection({
  platforms,
  accounts,
  searchQuery,
  onTaskUpdate,
  pendingConfirm,
  onPendingConfirmChange,
}: PlaylistSectionProps) {
  const { t, formatTime, formatDate } = useI18n()
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
  // 手动刷新冷却倒计时（秒）：与主进程限流阈值同口径，防连点触发平台风控
  const [refreshCooldown, setRefreshCooldown] = useState(0)
  const [error, setError] = useState<string>('')

  // --- 歌单选择与右键菜单 ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // 拖拽框选：mousedown 记录锚点，移动超阈值后进入框选，行 mouseenter 扩展范围
  const dragRef = useRef<{ anchorId: string; startX: number; startY: number; moved: boolean } | null>(
    null,
  )
  const suppressClickRef = useRef(false)

  // --- 跨平台歌单同步状态 ---
  const [syncRunning, setSyncRunning] = useState(false)
  const [syncProgress, setSyncProgress] = useState<{ ratio: number; stage: string } | null>(null)

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
        const res = await window.electronAPI.platforms.userPlaylists(active, force)
        if (res.throttled) {
          notify('warning', t('playlist.refreshThrottled'))
        }
        log.info('playlist.list.fetch', '拉取歌单列表', {
          platform: active,
          count: res.data.length,
          fromCache: res.fromCache,
          force,
        })
        setPlaylists(res.data)
        // 刷新后剔除已不存在的选择
        setSelectedIds((prev) => {
          const ids = new Set(res.data.map((p) => p.id))
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

  useEffect(() => {
    setPlaylists([])
    setSongs([])
    setActiveId(null)
    setSelectedIds(new Set())
    setMenu(null)
    void fetchPlaylists()
  }, [fetchPlaylists])

  // 右键菜单：点击外部或 Esc 关闭
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

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
      const res = await window.electronAPI.platforms.playlistSongs(active, id)
      log.info('playlist.songs.fetch', '拉取歌单歌曲', {
        platform: active,
        playlistId: id,
        count: res.data.length,
        fromCache: res.fromCache,
      })
      setSongs(res.data)
    } catch (e) {
      log.error('playlist.songs.fetch-failed', '拉取歌曲失败', e, { platform: active, playlistId: id })
      setError(e instanceof Error ? e.message : t('playlist.fetchSongsFailed'))
    } finally {
      setLoading(false)
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

  /** 右键行：未选中则单选该行，随后在鼠标位置弹出菜单 */
  const handleRowContextMenu = (e: ReactMouseEvent, playlist: PlatformPlaylist) => {
    e.preventDefault()
    log.debug('playlist.context-menu', '打开歌单右键菜单', { playlistId: playlist.id })
    if (!selectedIds.has(playlist.id)) {
      setSelectedIds(new Set([playlist.id]))
    }
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 232),
      y: Math.min(e.clientY, window.innerHeight - 320),
    })
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

  // --- 跨平台歌单同步 ---

  /** 同步失败条目按稳定 reason 码翻译；平台原始错误直接透传。 */
  const failedMessage = (f: SyncFailedItem): string => {
    const title = `${f.query.title}${f.query.artist ? ` - ${f.query.artist}` : ''}`
    switch (f.reason) {
      case 'no-match':
        return t('sync.failedNoMatch', { title })
      case 'unresolved':
        return t('sync.failedUnresolved', { title })
      case 'rate-limited':
        return t('sync.failedRateLimited')
      default:
        return f.message
    }
  }

  /** 把所选歌单的歌曲同步到目标平台（完整流程：拉歌 → 建任务 → 进度/选择/结果） */
  const handleSyncTo = async (targetPlatform: string) => {
    const selected = playlists.filter((p) => selectedIds.has(p.id))
    if (selected.length === 0 || syncRunning || pendingConfirm !== null) return
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
    setSyncRunning(true)
    setSyncProgress(null)
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

      const taskId = `task-${Date.now()}`
      const createdAt = formatTime(new Date())
      const name =
        selected.length === 1
          ? selected[0].name
          : t('playlist.syncNameMultiple', { name: selected[0].name, count: selected.length })
      const detailRef: SyncItemResult[] = []
      const baseTask: SyncTaskRecord = {
        id: taskId,
        name,
        targetPlatform,
        source: 'playlist-import',
        status: 'running',
        total: queries.length,
        added: 0,
        failed: 0,
        createdAt,
        progress: 0,
        failedDetail: [],
        detail: [],
      }
      onTaskUpdate(baseTask)

      const offProgress = window.electronAPI.platforms.onSyncProgress((p) => {
        if (p.taskId !== taskId) return
        setSyncProgress(p)
        onTaskUpdate({ ...baseTask, progress: p.ratio, detail: [...detailRef] })
      })
      const offStep = window.electronAPI.platforms.onSyncStep((step) => {
        if (step.taskId !== taskId) return
        const idx = detailRef.findIndex((d) => d.index === step.item.index)
        if (idx === -1) detailRef.push(step.item)
        else detailRef[idx] = step.item
        onTaskUpdate({ ...baseTask, progress: baseTask.progress, detail: [...detailRef] })
      })

      try {
        const { taskId: syncTaskId, report: rep } = await window.electronAPI.platforms.syncPlaylist(
          targetPlatform,
          taskId,
          queries,
          name,
          formatDate(new Date()),
        )
        const finalDetail = rep.items ?? [...detailRef]

        if (rep.status === 'choice-needed') {
          log.info('playlist.sync-choice-needed', '歌单同步需要手动选择', {
            targetPlatform,
            choices: rep.choices.length,
          })
          const runningTask: SyncTaskRecord = {
            ...baseTask,
            name: rep.playlistName,
            failed: rep.failed.length,
            progress: 1,
            failedDetail: rep.failed.map(failedMessage),
            detail: finalDetail,
          }
          onTaskUpdate(runningTask)
          onPendingConfirmChange({
            syncTaskId,
            task: runningTask,
            target: targetPlatform,
            choices: rep.choices,
          })
          return
        }

        if (rep.status === 'stopped') {
          log.info('playlist.sync-stopped', '歌单同步被用户停止', {
            targetPlatform,
            added: rep.added,
          })
          onTaskUpdate({
            ...baseTask,
            name: rep.playlistName,
            status: 'stopped',
            added: rep.added,
            failed: rep.failed.length,
            progress: 1,
            failedDetail: rep.failed.map(failedMessage),
            detail: finalDetail,
          })
          notify(
            'warning',
            t('toast.syncStoppedTitle'),
            t('toast.syncStoppedDetail', { name: rep.playlistName }),
          )
          return
        }

        const ok = rep.playlistId !== ''
        log.info('playlist.sync-done', '歌单同步结束', {
          targetPlatform,
          playlistId: rep.playlistId,
          added: rep.added,
          failed: rep.failed.length,
        })
        if (ok) {
          if (rep.failed.length > 0) {
            notify(
              'warning',
              t('toast.syncDoneTitle'),
              t('toast.syncPartialDetail', {
                added: rep.added,
                total: rep.total,
                name: rep.playlistName,
                failed: rep.failed.length,
              }),
            )
          } else {
            notify(
              'success',
              t('toast.syncDoneTitle'),
              t('toast.syncDoneDetail', {
                added: rep.added,
                total: rep.total,
                name: rep.playlistName,
              }),
            )
          }
        } else {
          notify(
            'error',
            t('toast.syncNoneTitle'),
            t('toast.syncNoneDetail', { count: rep.failed.length || rep.total }),
          )
        }
        onTaskUpdate({
          ...baseTask,
          name: rep.playlistName,
          status: ok ? 'done' : 'failed',
          added: rep.added,
          failed: rep.failed.length,
          progress: 1,
          failedDetail: rep.failed.map(failedMessage),
          detail: finalDetail,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : t('sync.failedGeneric')
        log.error('playlist.sync-failed', '歌单同步失败', e, {
          sourcePlatform: active,
          targetPlatform,
        })
        notify('error', t('toast.syncFailedTitle'), msg)
        onTaskUpdate({
          ...baseTask,
          status: 'failed',
          added: 0,
          failed: queries.length,
          progress: 1,
          failedDetail: [msg],
          detail: [...detailRef],
        })
      } finally {
        offProgress()
        offStep()
      }
    } catch (e) {
      log.error('playlist.sync-gather-failed', '拉取歌单歌曲失败', e, { sourcePlatform: active })
      notify('error', t('playlist.fetchSongsFailed'))
    } finally {
      setSyncRunning(false)
      setSyncProgress(null)
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
              {PLATFORM_LOGOS[p.id] ? (
                <img src={PLATFORM_LOGOS[p.id]} alt={p.name} className="h-5 w-5 object-contain" />
              ) : (
                <span className="material-symbols-outlined text-base">{p.icon}</span>
              )}
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
          <div className="w-72 shrink-0">
            <div className="rounded-lg border border-outline-variant bg-surface-container-low">
              <div className="flex items-center justify-between border-b border-outline-variant px-3 py-2">
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
              <ul className="max-h-[32rem] select-none space-y-0.5 overflow-y-auto p-1.5">
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
                      <span className="min-w-0 flex-1 truncate font-body-md text-body-md">
                        {p.name}
                      </span>
                      <span className="font-label-mono text-label-mono text-outline">
                        {p.songCount}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {syncRunning && (
              <div className="mt-2 rounded-lg border border-outline-variant bg-surface-container-low p-2">
                {syncProgress ? (
                  <>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.round(syncProgress.ratio * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">
                      {syncProgress.stage === 'matching'
                        ? t('textCreator.matching')
                        : t('textCreator.adding')}{' '}
                      {Math.round(syncProgress.ratio * 100)}%
                    </p>
                  </>
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
                maxHeightClass="max-h-[30rem]"
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
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 w-56 rounded-lg border border-outline-variant bg-surface-container p-1 shadow-lg shadow-black/40"
        >
          {singlePlaylist && canManage && (
            <button
              type="button"
              onClick={() => {
                setMenu(null)
                handleMenuRename()
              }}
              className={MENU_ITEM}
            >
              <span className="material-symbols-outlined text-base">edit</span>
              {t('playlist.rename')}
            </button>
          )}
          {singlePlaylist && canManage && syncTargets.length > 0 && (
            <div className="my-1 h-px bg-outline-variant" />
          )}
          {syncTargets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setMenu(null)
                void handleSyncTo(p.id)
              }}
              className={MENU_ITEM}
            >
              {PLATFORM_LOGOS[p.id] ? (
                <img src={PLATFORM_LOGOS[p.id]} alt={p.name} className="h-4 w-4 object-contain" />
              ) : (
                <span className="material-symbols-outlined text-base">{p.icon}</span>
              )}
              {t('playlist.syncToPlatform', { platform: p.name })}
            </button>
          ))}
          {(singlePlaylist?.appUrl ?? singlePlaylist?.webUrl) && (
            <div className="my-1 h-px bg-outline-variant" />
          )}
          {singlePlaylist?.appUrl && (
            <button
              type="button"
              onClick={() => {
                setMenu(null)
                void handleOpenUrl(singlePlaylist.appUrl as string)
              }}
              className={MENU_ITEM}
            >
              <span className="material-symbols-outlined text-base">open_in_new</span>
              {t('playlist.openInApp', { platform: sourceName })}
            </button>
          )}
          {singlePlaylist?.webUrl && (
            <button
              type="button"
              onClick={() => {
                setMenu(null)
                void handleOpenUrl(singlePlaylist.webUrl as string)
              }}
              className={MENU_ITEM}
            >
              <span className="material-symbols-outlined text-base">public</span>
              {t('playlist.openInBrowser')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
