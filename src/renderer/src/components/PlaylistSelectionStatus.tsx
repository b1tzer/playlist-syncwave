import { useI18n } from '../i18n'

interface PlaylistSelectionStatusProps {
  count: number
  total: number
  onClear: () => void
}

/** 歌单列表头部共用的已选计数与清除入口 */
export default function PlaylistSelectionStatus({
  count,
  total,
  onClear,
}: PlaylistSelectionStatusProps) {
  const { t } = useI18n()
  if (count > 0) {
    return (
      <div className="flex items-center gap-1">
        <span className="font-label-mono text-label-mono text-primary">
          {t('playlist.selectedCount', { count })}
        </span>
        <button
          onClick={onClear}
          title={t('playlist.clearSelection')}
          className="flex items-center rounded-md p-0.5 text-outline transition-colors hover:bg-surface-container-highest hover:text-on-surface"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
    )
  }
  return <span className="font-label-mono text-label-mono text-outline">{total}</span>
}
