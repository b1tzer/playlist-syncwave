import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import type { PlatformSong } from '@core/models/platform'
import type { EncyclopediaConfirmRequest } from '@core/models/encyclopedia'
import { useI18n } from '../i18n'
import { formatDuration } from '../sync/helpers'
import CoverImage from './CoverImage'
import EncyclopediaPopover, {
  ArtistLinks,
  EncyclopediaLink,
  type EncyclopediaTarget,
} from './EncyclopediaPopover'
import Tooltip from './Tooltip'

interface SongListProps {
  songs: PlatformSong[]
  /** 是否显示行号（歌单主列表显示，搜索结果不显示） */
  showIndex?: boolean
  /** 是否显示封面 */
  showCover?: boolean
  /** 是否显示列头（歌单歌曲主列表开启，搜索结果等紧凑列表不需要） */
  showHeader?: boolean
  /** 滚动容器最大高度类名，如 max-h-64；省略时可由 className 控制伸缩 */
  maxHeightClass?: string
  /** 列表容器附加类名（边框、圆角、间距等） */
  className?: string
  /** 行尾操作区，由调用方注入，模板不关心具体操作 */
  renderAction?: (song: PlatformSong) => ReactNode
  /** 歌名下方第二行辅助信息（如失败原因），由调用方注入 */
  renderSubtitle?: (song: PlatformSong) => ReactNode
  /** 列表末尾追加内容（如滚动分页哨兵） */
  renderFooter?: () => ReactNode
  /** 后台重新验证后需要行级高亮的歌曲 id（动画结束由 onFlashEnd 回调清除） */
  flashIds?: Set<string>
  onFlashEnd?: (id: string) => void
  /** 开启行多选与批量删除工具条（仅歌单主列表使用，需同时开启 showHeader） */
  selectable?: boolean
  /** 批量删除选中歌曲；返回 false 表示失败，保留选择 */
  onRemoveSelected?: (ids: string[]) => Promise<boolean> | boolean
  /** 删除能力不可用时禁用批量删除 */
  removeDisabled?: boolean
  /** 删除不可用时的悬浮原因 */
  removeDisabledReason?: string
  /** 百科查询平台（歌名详情卡始终可用；歌手/专辑名仅在提供平台且支持百科时可点） */
  encyclopediaPlatform?: string
  /** 列表级平台是否支持百科查询（歌手/专辑名可点性）；缺省视为不支持 */
  encyclopediaSupported?: boolean
  /** 平台展示名（百科面板来源标识） */
  platformName?: string
  /** 平台 material-symbols 图标名（百科面板来源标识） */
  platformIcon?: string
  /** 按歌曲解析百科平台（本地歌单按每首歌的来源平台；未提供时用列表级 encyclopediaPlatform） */
  encyclopediaPlatformOf?: (
    song: PlatformSong,
  ) => { platform: string; name: string; icon: string; encyclopedia: boolean } | undefined
  /** 用户选定同名候选后回调（本地歌单回写歌手 id） */
  onEncyclopediaConfirm?: (req: EncyclopediaConfirmRequest, target: EncyclopediaTarget) => void
}

export default function SongList({
  songs,
  showIndex = true,
  showCover = true,
  showHeader = false,
  maxHeightClass,
  className = '',
  renderAction,
  renderSubtitle,
  renderFooter,
  flashIds,
  onFlashEnd,
  selectable = false,
  onRemoveSelected,
  removeDisabled = false,
  removeDisabledReason,
  encyclopediaPlatform,
  encyclopediaSupported,
  platformName,
  platformIcon,
  encyclopediaPlatformOf,
  onEncyclopediaConfirm,
}: SongListProps) {
  const { t } = useI18n()
  // 整列缺失时隐藏该列，避免全空占位
  const hasAlbum = songs.some((s) => s.album !== undefined)
  const hasDuration = songs.some((s) => s.durationMs !== undefined)
  /** 已完成入场动画的歌曲行：高亮动画结束后恢复无动画态，避免重播入场动画 */
  const [enteredIds, setEnteredIds] = useState<Set<string>>(new Set())
  const markEntered = (id: string) => {
    setEnteredIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkRemoving, setBulkRemoving] = useState(false)
  const [bulkTip, setBulkTip] = useState<{ x: number; y: number; text: string } | null>(null)
  /** 百科面板：锚点（点击文本下方）+ 点击目标 */
  const [encyclopedia, setEncyclopedia] = useState<{
    target: EncyclopediaTarget
    x: number
    y: number
  } | null>(null)
  /** Shift 连选锚点：最后一次普通点选的行 */
  const anchorIdRef = useRef<string | null>(null)
  /** 拖拽框选：按下锚点 + 起点，移动超 5px 才进入框选 */
  const dragRef = useRef<{
    anchorId: string
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  /** 拖拽结束后同一行释放会触发 click，抑制一次避免撤销框选 */
  const suppressClickRef = useRef(false)

  useEffect(() => {
    if (!selectable) return
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag || drag.moved) return
      if (Math.abs(e.clientX - drag.startX) > 5 || Math.abs(e.clientY - drag.startY) > 5) {
        drag.moved = true
        anchorIdRef.current = drag.anchorId
        setSelectedIds(new Set([drag.anchorId]))
      }
    }
    const onUp = () => {
      const wasDrag = dragRef.current?.moved ?? false
      dragRef.current = null
      if (wasDrag) {
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
  }, [selectable])

  // 歌曲列表整体替换（切歌单/删除后重排）时丢弃已不存在的选中项与锚点
  useEffect(() => {
    const valid = new Set(songs.map((s) => s.id))
    if (anchorIdRef.current && !valid.has(anchorIdRef.current)) anchorIdRef.current = null
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [songs])

  const allSelected = songs.length > 0 && songs.every((s) => selectedIds.has(s.id))
  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(songs.map((s) => s.id)))
  const clearSelection = () => {
    setBulkTip(null)
    anchorIdRef.current = null
    setSelectedIds(new Set())
  }
  const handleRowMouseDown = (e: ReactMouseEvent, song: PlatformSong) => {
    if (e.button !== 0) return
    // 百科面板打开时：本次点击只关闭面板（window mousedown 冒泡触发），
    // 不进入选择/框选流程——抑制随后的 click，避免「关闭面板的同时选中了歌曲」
    if (encyclopedia) {
      suppressClickRef.current = true
      setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
      return
    }
    dragRef.current = { anchorId: song.id, startX: e.clientX, startY: e.clientY, moved: false }
  }
  /** 拖拽经过的行：以按下行到当前行整段替换选择 */
  const handleRowMouseEnter = (song: PlatformSong) => {
    const drag = dragRef.current
    if (!drag?.moved) return
    const from = songs.findIndex((s) => s.id === drag.anchorId)
    const to = songs.findIndex((s) => s.id === song.id)
    if (from === -1 || to === -1) return
    const [start, end] = from < to ? [from, to] : [to, from]
    setSelectedIds(new Set(songs.slice(start, end + 1).map((s) => s.id)))
  }
  /** 点选切换选中；Shift 点选把锚点到当前行之间整段加入选择 */
  const handleRowClick = (e: ReactMouseEvent, song: PlatformSong) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (e.shiftKey && anchorIdRef.current) {
      const from = songs.findIndex((s) => s.id === anchorIdRef.current)
      const to = songs.findIndex((s) => s.id === song.id)
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from]
        setSelectedIds((prev) => new Set([...prev, ...songs.slice(start, end + 1).map((s) => s.id)]))
        return
      }
    }
    anchorIdRef.current = song.id
    toggleSelection(song.id)
  }

  /** 打开百科面板：锚点固定在点击文本的正下方，stopPropagation 避免触发行多选 */
  const openEncyclopedia = (e: SyntheticEvent<HTMLElement>, target: EncyclopediaTarget) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setEncyclopedia({ target, x: rect.left, y: rect.bottom + 4 })
  }

  /** 某首歌的百科平台：优先按歌解析（本地歌单多来源），回退列表级平台 */
  const platformOf = (song: PlatformSong) =>
    encyclopediaPlatformOf?.(song) ??
    (encyclopediaPlatform
      ? {
          platform: encyclopediaPlatform,
          name: platformName ?? '',
          icon: platformIcon ?? '',
          encyclopedia: encyclopediaSupported === true,
        }
      : undefined)

  const handleRemoveSelected = async () => {
    if (!onRemoveSelected || selectedIds.size === 0 || bulkRemoving) return
    setBulkTip(null)
    setBulkRemoving(true)
    try {
      const ok = await onRemoveSelected([...selectedIds])
      if (ok) {
        anchorIdRef.current = null
        setSelectedIds(new Set())
      }
    } finally {
      setBulkRemoving(false)
    }
  }

  return (
    <>
      <ul
        className={`divide-y divide-outline-variant overflow-y-auto ${maxHeightClass ?? ''} ${className}`}
      >
      {showHeader && selectable && selectedIds.size > 0 && (
        <li className="sticky top-0 z-20 flex items-center gap-2 bg-primary/10 px-4 py-1.5 font-label-md text-label-md text-primary">
          <span className="font-medium">{t('song.selectedCount', { count: selectedIds.size })}</span>
          <button
            type="button"
            onClick={toggleAll}
            disabled={allSelected}
            className="rounded-md px-2 py-1 transition-colors hover:bg-surface-container-high disabled:opacity-40"
          >
            {t('song.selectAll')}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={clearSelection}
            className="rounded-md px-2 py-1 transition-colors hover:bg-surface-container-high"
          >
            {t('song.clearSelection')}
          </button>
          <span
            className="flex shrink-0 items-center"
            onMouseEnter={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setBulkTip({
                x: rect.left + rect.width / 2,
                y: rect.bottom,
                text: removeDisabled
                  ? (removeDisabledReason ?? t('song.removeSelected'))
                  : t('song.removeSelected'),
              })
            }}
            onMouseLeave={() => setBulkTip(null)}
          >
            <button
              type="button"
              disabled={removeDisabled || bulkRemoving}
              aria-disabled={removeDisabled}
              onClick={() => void handleRemoveSelected()}
              className="flex items-center gap-1 rounded-md bg-error/10 px-2 py-1 font-medium text-error transition-colors hover:bg-error/20 disabled:opacity-40 disabled:hover:bg-error/10"
            >
              <span
                className={`material-symbols-outlined text-sm ${bulkRemoving ? 'animate-spin' : ''}`}
              >
                {bulkRemoving ? 'progress_activity' : 'delete'}
              </span>
              {bulkRemoving ? t('common.loading') : t('song.removeSelected')}
            </button>
          </span>
          {bulkTip && <Tooltip x={bulkTip.x} y={bulkTip.y} text={bulkTip.text} />}
        </li>
      )}
      {showHeader && !(selectable && selectedIds.size > 0) && (
        <li
          aria-hidden
          className="sticky top-0 z-10 flex items-center gap-3 bg-surface-container px-4 py-1.5 font-label-sm text-label-sm text-on-surface-variant"
        >
          {showIndex && (
            <span className="w-6 shrink-0 text-right font-label-mono text-label-mono">
              {t('song.columnIndex')}
            </span>
          )}
          {showCover && <span className="w-9 shrink-0" />}
          <span className="min-w-0 flex-1">{t('song.columnTitle')}</span>
          <span className="w-1/4 min-w-0">{t('song.columnArtist')}</span>
          {hasAlbum && <span className="w-1/4 min-w-0">{t('song.columnAlbum')}</span>}
          {hasDuration && (
            <span className="w-12 shrink-0 text-right font-label-mono text-label-mono">
              {t('song.columnDuration')}
            </span>
          )}
          {renderAction && <span className="w-9 shrink-0" />}
        </li>
      )}
      {songs.map((s, i) => {
        const subtitle = renderSubtitle?.(s)
        const action = renderAction?.(s)
        const flashing = flashIds?.has(s.id) ?? false
        const entered = enteredIds.has(s.id)
        const selected = selectedIds.has(s.id)
        return (
          <li
            key={s.id}
            className={`${flashing ? 'row-updated' : entered ? '' : 'list-item-enter'} group flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md transition-colors ${
              selectable ? 'cursor-pointer select-none' : ''
            } ${selected ? 'bg-primary/10 text-on-surface' : ''}`}
            style={
              flashing || entered ? undefined : { animationDelay: `${Math.min(i, 15) * 24}ms` }
            }
            onClick={selectable ? (e) => handleRowClick(e, s) : undefined}
            onMouseDown={selectable ? (e) => handleRowMouseDown(e, s) : undefined}
            onMouseEnter={selectable ? () => handleRowMouseEnter(s) : undefined}
            onDragStart={selectable ? (e) => e.preventDefault() : undefined}
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget) return
              if (flashing) {
                onFlashEnd?.(s.id)
                markEntered(s.id)
              } else {
                markEntered(s.id)
              }
            }}
          >
            {showIndex && (
              <span className="w-6 shrink-0 text-right font-label-mono text-label-mono text-outline">
                {i + 1}
              </span>
            )}
            {showCover && (
              <CoverImage
                src={s.coverUrl}
                alt={t('song.coverAlt', { title: s.title })}
                size="md"
                fallbackIcon="music_note"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <EncyclopediaLink
                  label={s.title}
                  onOpen={(e) => {
                    const ep = platformOf(s)
                    openEncyclopedia(e, {
                      type: 'song',
                      song: s,
                      platform: ep?.platform,
                      platformName: ep?.name,
                      platformIcon: ep?.icon,
                      // 详情卡内歌手/专辑是否可点，取决于来源平台是否支持百科
                      encyclopedia: ep?.encyclopedia === true,
                    })
                  }}
                />
              </div>
              {subtitle != null && (
                <div className="truncate font-label-sm text-label-sm">{subtitle}</div>
              )}
            </div>
            <span className="w-1/4 min-w-0 truncate text-on-surface-variant">
              <ArtistLinks
                artist={s.artist}
                singerIds={s.identifiers?.singerIds}
                clickable={platformOf(s)?.encyclopedia === true}
                onOpen={(e, part, idx, singerId) =>
                  openEncyclopedia(e, {
                    type: 'encyclopedia',
                    platform: platformOf(s)!.platform,
                    platformName: platformOf(s)!.name,
                    platformIcon: platformOf(s)!.icon,
                    kind: 'singer',
                    name: part,
                    id: singerId,
                    song: s,
                    singerIndex: idx,
                  })
                }
              />
            </span>
            {hasAlbum && (
              <span className="w-1/4 min-w-0 truncate text-on-surface-variant">
                {s.album && platformOf(s)?.encyclopedia === true ? (
                  <EncyclopediaLink
                    label={s.album}
                    onOpen={(e) =>
                      openEncyclopedia(e, {
                        type: 'encyclopedia',
                        platform: platformOf(s)!.platform,
                        platformName: platformOf(s)!.name,
                        platformIcon: platformOf(s)!.icon,
                        kind: 'album',
                        name: s.album!,
                        albumId: s.identifiers?.albumId,
                        albumMid: s.identifiers?.albumMid,
                        song: s,
                      })
                    }
                  />
                ) : (
                  (s.album ?? '')
                )}
              </span>
            )}
            {hasDuration && (
              // 固定宽度 + 右对齐：时长文本长度不一（-- / 3:45 / 12:34），
              // 不固定会导致列宽参差、后续操作按钮起点逐行偏移
              <span className="w-12 shrink-0 text-right font-label-mono text-label-mono text-outline">
                {formatDuration(s.durationMs)}
              </span>
            )}
            {showHeader && renderAction ? (
              <span className="flex w-9 shrink-0 justify-end">{action}</span>
            ) : (
              action
            )}
          </li>
        )
      })}
      {renderFooter?.()}
      </ul>
      {encyclopedia && (
        <EncyclopediaPopover
          target={encyclopedia.target}
          x={encyclopedia.x}
          y={encyclopedia.y}
          onClose={() => setEncyclopedia(null)}
          onConfirmEntity={onEncyclopediaConfirm}
          onNavigate={(next) =>
            setEncyclopedia((prev) => (prev ? { ...prev, target: next } : null))
          }
        />
      )}
    </>
  )
}
