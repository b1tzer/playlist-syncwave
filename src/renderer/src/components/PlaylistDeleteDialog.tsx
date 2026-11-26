import { useEffect } from 'react'
import { useI18n } from '../i18n'

interface PlaylistDeleteDialogProps {
  /** 待删除歌单名；null 表示不显示 */
  name: string | null
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/** 平台歌单与本地歌单共用的删除确认弹层 */
export default function PlaylistDeleteDialog({
  name,
  busy = false,
  onCancel,
  onConfirm,
}: PlaylistDeleteDialogProps) {
  const { t } = useI18n()

  useEffect(() => {
    if (name === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [name, onCancel])

  if (name === null) return null

  return (
    <div
      className="dialog-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="dialog-panel-enter flex w-80 flex-col gap-4 rounded-lg border border-outline-variant bg-surface-container p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5">
          <span className="material-symbols-outlined text-base text-error">delete</span>
          <p className="font-body-md text-body-md text-on-surface">
            {t('playlist.deleteConfirmWithName', { name })}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
          >
            {t('playlist.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-error px-3 py-1.5 font-label-md text-label-md font-medium text-on-error transition-colors hover:bg-error/85 disabled:opacity-40"
          >
            {t('playlist.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
