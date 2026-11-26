import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import PlatformLogo from './PlatformLogo'
import CoverImage from './CoverImage'
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

/** 歌单列表模板的最小数据结构：平台歌单与本地歌单都可直接传入 */
export interface PlaylistListItem {
  id: string
  name: string
  coverUrl?: string
  songCount?: number
  sources?: Array<{ platform: string; playlistId: string }>
}

interface PlaylistListProps<T extends PlaylistListItem> {
  items: T[]
  /** 本地歌单来源 logo 所需的平台元信息 */
  platforms?: Array<{ id: string; name: string; icon?: string }>
  activeId: string | null
  selectedIds: Set<string>
  renamingId: string | null
  renameDraft: string
  renamePlaceholder: string
  emptyText: string
  loading?: boolean
  loadingText?: string
  renameDisabled?: boolean
  /** 后台重新验证后需要行级高亮的 id */
  flashIds?: Set<string>
  onFlashEnd?: (id: string) => void
  onOpen: (id: string) => void
  onToggleSelect?: (id: string) => void
  onDoubleClick?: (id: string) => void
  onMouseDown?: (e: ReactMouseEvent, id: string) => void
  onMouseEnter?: (id: string) => void
  onContextMenu?: (e: ReactMouseEvent, item: T) => void
  /** 列表空白区右键（行右键会 stopPropagation，不会触发这里） */
  onBlankContextMenu?: (e: ReactMouseEvent) => void
  onRenameChange: (value: string) => void
  onRenameKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  onRenameBlur: () => void
  /** 新建歌单内联表单（右键菜单触发） */
  creating?: boolean
  createDraft?: string
  createPlaceholder?: string
  createLabel?: string
  cancelLabel?: string
  onCreateChange?: (value: string) => void
  onCreateSubmit?: () => void
  onCreateCancel?: () => void
  consumeSuppressedClick?: () => boolean
  renderFooter?: () => ReactNode
}

/** 平台歌单与本地歌单共用的唯一列表模板：行结构、样式、动效、多选高亮与行内重命名都在这里 */
export default function PlaylistList<T extends PlaylistListItem>({
  items,
  platforms,
  activeId,
  selectedIds,
  renamingId,
  renameDraft,
  renamePlaceholder,
  emptyText,
  loading = false,
  loadingText,
  renameDisabled = false,
  flashIds,
  onFlashEnd,
  onOpen,
  onToggleSelect,
  onDoubleClick,
  onMouseDown,
  onMouseEnter,
  onContextMenu,
  onBlankContextMenu,
  onRenameChange,
  onRenameKeyDown,
  onRenameBlur,
  creating = false,
  createDraft = '',
  createPlaceholder,
  createLabel,
  cancelLabel,
  onCreateChange,
  onCreateSubmit,
  onCreateCancel,
  consumeSuppressedClick,
  renderFooter,
}: PlaylistListProps<T>) {
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [enteredIds, setEnteredIds] = useState<Set<string>>(new Set())
  const markEntered = (id: string) => {
    setEnteredIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  useEffect(() => {
    const valid = new Set(items.map((item) => item.id))
    setEnteredIds((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  if (loading && items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 font-label-md text-label-md text-outline">
        <span className="material-symbols-outlined animate-spin text-xl">progress_activity</span>
        {loadingText}
      </div>
    )
  }

  return (
    <ul className={playlistListClass} onContextMenu={onBlankContextMenu}>
      {creating && (
        <li className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5">
          <input
            autoFocus
            value={createDraft}
            onChange={(e) => onCreateChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreateSubmit?.()
              if (e.key === 'Escape') onCreateCancel?.()
            }}
            placeholder={createPlaceholder}
            className="min-w-0 flex-1 border-0 border-b border-primary bg-transparent px-0 py-0.5 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline"
          />
          <button
            onClick={onCreateSubmit}
            disabled={!createDraft.trim()}
            className="rounded-md bg-primary px-2 py-1 font-label-sm text-label-sm font-medium text-on-primary disabled:opacity-40"
          >
            {createLabel}
          </button>
          <button
            onClick={onCreateCancel}
            className="rounded-md px-2 py-1 font-label-sm text-label-sm text-on-surface-variant hover:text-on-surface"
          >
            {cancelLabel}
          </button>
        </li>
      )}
      {items.length === 0 && <li className={playlistEmptyClass}>{emptyText}</li>}
      {items.map((item, i) => {
        const flashing = flashIds?.has(item.id) ?? false
        const entered = enteredIds.has(item.id)
        return (
          <li
            key={item.id}
            className={playlistRowAnimationClass(flashing, entered)}
            style={
              flashing || entered ? undefined : { animationDelay: `${Math.min(i, 15) * 24}ms` }
            }
            onAnimationEnd={(e) => {
              if (e.target !== e.currentTarget) return
              if (flashing) onFlashEnd?.(item.id)
              markEntered(item.id)
            }}
          >
            {renamingId === item.id ? (
              <div className={playlistRenameRowClass}>
                <CoverImage src={item.coverUrl} alt={item.name} size="sm" fallbackIcon="queue_music" />
                <input
                  ref={renameInputRef}
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => onRenameChange(e.target.value)}
                  onKeyDown={onRenameKeyDown}
                  onBlur={onRenameBlur}
                  placeholder={renamePlaceholder}
                  disabled={renameDisabled}
                  className={playlistRenameInputClass}
                />
              </div>
            ) : (
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (e.detail === 2) return
                  if (consumeSuppressedClick?.()) return
                  if (onToggleSelect && (e.metaKey || e.ctrlKey)) {
                    onToggleSelect(item.id)
                    return
                  }
                  onOpen(item.id)
                }}
                onDoubleClick={() => onDoubleClick?.(item.id)}
                onMouseDown={(e) => onMouseDown?.(e, item.id)}
                onMouseEnter={() => onMouseEnter?.(item.id)}
                onContextMenu={(e) => onContextMenu?.(e, item)}
                className={playlistRowClass(activeId === item.id, selectedIds.has(item.id))}
              >
                <CoverImage src={item.coverUrl} alt={item.name} size="sm" fallbackIcon="queue_music" />
                <MarqueeText text={item.name} className={playlistNameClass} />
                <span className="flex shrink-0 items-center gap-1">
                  {(item.sources ?? []).map((source) => {
                    const meta = platforms?.find((m) => m.id === source.platform)
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
                  <span className={playlistCountClass}>{item.songCount ?? ''}</span>
                </span>
              </div>
            )}
          </li>
        )
      })}
      {renderFooter?.()}
    </ul>
  )
}
