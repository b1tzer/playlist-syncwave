import type { PlatformSong } from '@core/models/platform'
import { useI18n } from '../i18n'
import SongList from './SongList'
import LoadMoreSentinel from './LoadMoreSentinel'

interface SongSearchResultsProps {
  /** 已加载的搜索结果（跨页累积，序号连续） */
  songs: PlatformSong[]
  /** 是否还有下一页（哨兵提前触发加载） */
  hasMore: boolean
  /** 加载下一页中 */
  loadingMore?: boolean
  /** 添加中的歌曲 id（按钮转圈禁用） */
  addingIds: ReadonlySet<string>
  /** 已添加（含歌单已有）的歌曲 id：显示「已添加」禁用态 */
  addedIds: ReadonlySet<string>
  onAdd: (song: PlatformSong) => void
  onLoadMore: () => void
  /** 空结果文案 */
  emptyText: string
  /** 滚动容器最大高度类名，如 max-h-64 */
  maxHeightClass?: string
  /** 百科查询平台（透传 SongList；未提供时歌手/专辑名不可点） */
  encyclopediaPlatform?: string
  /** 平台是否支持百科查询（透传 SongList；缺省视为不支持） */
  encyclopediaSupported?: boolean
  platformName?: string
}

/**
 * 平台歌曲搜索结果清单：与歌单歌曲列表复用 SongList（行号/封面/时长列一致），
 * 支持滚动分页（哨兵提前预取下一页）与添加按钮三态（添加/添加中/已添加）。
 * 供歌单详情「添加歌曲」与本地歌单「从平台添加」两处共用。
 */
export default function SongSearchResults({
  songs,
  hasMore,
  loadingMore = false,
  addingIds,
  addedIds,
  onAdd,
  onLoadMore,
  emptyText,
  maxHeightClass = 'max-h-64',
  encyclopediaPlatform,
  encyclopediaSupported,
  platformName,
}: SongSearchResultsProps) {
  const { t } = useI18n()

  if (songs.length === 0) {
    return (
      <p className="rounded-md border border-outline-variant px-3 py-2 font-label-sm text-label-sm text-outline">
        {emptyText}
      </p>
    )
  }

  return (
    <SongList
      songs={songs}
      maxHeightClass={maxHeightClass}
      className="rounded-md border border-outline-variant"
      encyclopediaPlatform={encyclopediaPlatform}
      encyclopediaSupported={encyclopediaSupported}
      platformName={platformName}
      renderFooter={
        hasMore
          ? () => (
              <div className="flex justify-center px-4 py-1.5">
                {loadingMore ? (
                  <span className="material-symbols-outlined animate-spin text-sm text-outline">
                    progress_activity
                  </span>
                ) : (
                  <LoadMoreSentinel onVisible={onLoadMore} />
                )}
              </div>
            )
          : undefined
      }
      renderAction={(s) => {
        const added = addedIds.has(s.id)
        const adding = addingIds.has(s.id)
        return (
          <button
            onClick={() => onAdd(s)}
            disabled={added || adding}
            className="flex shrink-0 items-center gap-1 rounded-md border border-outline-variant px-2 py-0.5 font-label-sm text-label-sm text-primary transition-colors hover:bg-surface-container-high disabled:opacity-50"
          >
            <span
              className={`material-symbols-outlined text-sm ${adding ? 'animate-spin' : ''}`}
            >
              {added ? 'check' : adding ? 'progress_activity' : 'add'}
            </span>
            {added ? t('playlist.added') : adding ? t('playlist.adding') : t('playlist.add')}
          </button>
        )
      }}
    />
  )
}
