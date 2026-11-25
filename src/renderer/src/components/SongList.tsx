import { useState, type ReactNode } from 'react'
import type { PlatformSong } from '@core/models/platform'
import { useI18n } from '../i18n'
import { formatDuration } from '../sync/helpers'

interface SongListProps {
  songs: PlatformSong[]
  /** 是否显示行号（歌单主列表显示，搜索结果不显示） */
  showIndex?: boolean
  /** 是否显示封面 */
  showCover?: boolean
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
}

function SongCover({ song }: { song: PlatformSong }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)
  if (!song.coverUrl || failed) {
    return (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-outline">
        <span className="material-symbols-outlined text-lg">music_note</span>
      </span>
    )
  }
  return (
    <img
      src={song.coverUrl}
      alt={t('song.coverAlt', { title: song.title })}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-9 w-9 shrink-0 rounded-md object-cover"
    />
  )
}

export default function SongList({
  songs,
  showIndex = true,
  showCover = true,
  maxHeightClass,
  className = '',
  renderAction,
  renderSubtitle,
  renderFooter,
  flashIds,
  onFlashEnd,
}: SongListProps) {
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

  return (
    <ul
      className={`divide-y divide-outline-variant overflow-y-auto ${maxHeightClass ?? ''} ${className}`}
    >
      {songs.map((s, i) => {
        const subtitle = renderSubtitle?.(s)
        const flashing = flashIds?.has(s.id) ?? false
        const entered = enteredIds.has(s.id)
        return (
          <li
            key={s.id}
            className={`${flashing ? 'row-updated' : entered ? '' : 'list-item-enter'} group flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md`}
            style={
              flashing || entered ? undefined : { animationDelay: `${Math.min(i, 15) * 24}ms` }
            }
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
            {showCover && <SongCover song={s} />}
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
            {renderAction?.(s)}
          </li>
        )
      })}
      {renderFooter?.()}
    </ul>
  )
}
