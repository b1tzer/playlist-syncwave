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
}: SongListProps) {
  // 整列缺失时隐藏该列，避免全空占位
  const hasAlbum = songs.some((s) => s.album !== undefined)
  const hasDuration = songs.some((s) => s.durationMs !== undefined)

  return (
    <ul
      className={`divide-y divide-outline-variant overflow-y-auto ${maxHeightClass ?? ''} ${className}`}
    >
      {songs.map((s, i) => {
        const subtitle = renderSubtitle?.(s)
        return (
          <li
            key={s.id}
            className="list-item-enter group flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md"
            style={{ animationDelay: `${Math.min(i, 15) * 24}ms` }}
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
              <span className="shrink-0 font-label-mono text-label-mono text-outline">
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
