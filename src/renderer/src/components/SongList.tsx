import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { PlatformSong } from '@core/models/platform'
import { useI18n } from '../i18n'
import { formatDuration } from '../sync/helpers'
import CoverImage from './CoverImage'
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
  /** Shift 连选锚点：最后一次普通点选的行 */
  const anchorIdRef = useRef<string | null>(null)

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
  /** 点选切换选中；Shift 点选把锚点到当前行之间整段加入选择 */
  const handleRowClick = (e: ReactMouseEvent, song: PlatformSong) => {
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
            className={`${flashing ? 'row-updated' : entered ? '' : 'list-item-enter'} group flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md ${
              selectable ? 'cursor-pointer select-none' : ''
            } ${selected ? 'bg-primary/10' : ''}`}
            style={
              flashing || entered ? undefined : { animationDelay: `${Math.min(i, 15) * 24}ms` }
            }
            onClick={selectable ? (e) => handleRowClick(e, s) : undefined}
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
              <div className="truncate">{s.title}</div>
              {subtitle != null && (
                <div className="truncate font-label-sm text-label-sm">{subtitle}</div>
              )}
            </div>
            <span className="w-1/4 min-w-0 truncate text-on-surface-variant">{s.artist}</span>
            {hasAlbum && (
              <span className="w-1/4 min-w-0 truncate text-on-surface-variant">
                {s.album ?? ''}
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
  )
}
