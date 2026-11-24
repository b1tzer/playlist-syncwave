import { useState, type ReactNode } from 'react'
import type { PendingConfirmSession, SyncReport } from '@core/models/sync'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import { failedDetailLines, formatDuration } from '../sync/helpers'

const log = createRendererLogger('renderer.confirm-dialog')

/**
 * 候选版本展示模板：弹窗渲染所需的固定参数（字段缺省为空，模板不变）。
 * 数据来源为平台搜索结果的 PlatformSong，映射至此结构。
 */
export interface CandidateDisplayTemplate {
  /** 候选歌曲 ID */
  id: string
  /** 候选歌名 */
  title: string
  /** 候选歌手 */
  artist: string
  /** 所属专辑（可为空） */
  album?: string
  /** 封面图 URL（可为空，空则显示占位图标） */
  coverUrl?: string
  /** 时长毫秒（可为空） */
  durationMs?: number
}

/** 目标歌曲模板：用户歌单中的原始条目，用于与候选比对高亮 */
export interface TargetTrackTemplate {
  title: string
  artist?: string
}

interface ConfirmSyncDialogProps {
  session: PendingConfirmSession
  /** 每首的选择结果：choiceIndex -> 候选歌曲 id */
  selections: Record<number, string>
  onSelect: (index: number, songId: string) => void
  onConfirm: () => void
  onCancel: () => void
  /** 确认写入完成后关闭弹窗 */
  onDone: () => void
  confirming: boolean
  confirmError: string
  confirmResult: SyncReport | null
}

/** 文本与目标一致处（忽略大小写的子串）高亮 */
function HighlightText({
  text,
  target,
  className,
}: {
  text: string
  target?: string
  className: string
}): ReactNode {
  if (!target) return <>{text}</>
  const idx = text.toLocaleLowerCase().indexOf(target.toLocaleLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className={className}>{text.slice(idx, idx + target.length)}</span>
      {text.slice(idx + target.length)}
    </>
  )
}

/** 封面图组件：防盗链 referer 置空，加载失败回退占位图标 */
function Cover({ template }: { template: CandidateDisplayTemplate }) {
  const [failed, setFailed] = useState(false)
  if (!template.coverUrl || failed) {
    return (
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-surface-container-highest">
        <span className="material-symbols-outlined text-2xl text-outline">music_note</span>
      </span>
    )
  }
  return (
    <img
      src={template.coverUrl}
      alt={template.album ?? template.title}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-14 w-14 shrink-0 rounded-md object-cover"
    />
  )
}

/** 候选卡片：按固定模板参数渲染，歌名/歌手与目标一致处高亮 */
function CandidateCard({
  candidate,
  target,
  selected,
  onPick,
}: {
  candidate: CandidateDisplayTemplate
  target: TargetTrackTemplate
  selected: boolean
  onPick: (songId: string) => void
}) {
  return (
    <button
      onClick={() => onPick(candidate.id)}
      className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors ${
        selected
          ? 'border-primary bg-primary/10'
          : 'border-outline-variant bg-surface-container-lowest hover:border-primary'
      }`}
    >
      <Cover template={candidate} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-body-md text-body-md text-on-surface">
          <HighlightText
            text={candidate.title}
            target={target.title}
            className="font-medium text-primary"
          />
        </span>
        <span className="block truncate font-label-sm text-label-sm text-on-surface-variant">
          <HighlightText text={candidate.artist} target={target.artist} className="text-primary" />
        </span>
        {candidate.album && (
          <span className="block truncate font-label-sm text-label-sm text-outline">
            {candidate.album}
          </span>
        )}
      </span>
      {candidate.durationMs !== undefined && (
        <span className="shrink-0 font-label-mono text-label-mono text-outline">
          {formatDuration(candidate.durationMs)}
        </span>
      )}
      {selected && (
        <span className="material-symbols-outlined shrink-0 text-primary">check_circle</span>
      )}
    </button>
  )
}

/**
 * 同步待确认分步弹窗：一次展示一首同名歌曲的候选版本，
 * 选完自动进入下一首；全部选完才可确认创建歌单。
 * 挂载在 App 层，切换视图不丢失。
 * 布局：头部与底部固定，仅候选区域滚动（整体窗口不随内容撑开）。
 */
export default function ConfirmSyncDialog({
  session,
  selections,
  onSelect,
  onConfirm,
  onCancel,
  onDone,
  confirming,
  confirmError,
  confirmResult,
}: ConfirmSyncDialogProps) {
  const { t } = useI18n()
  const [current, setCurrent] = useState(0)

  const { choices } = session
  const total = choices.length
  const choice = choices[Math.min(current, total - 1)]
  const selectedCount = Object.keys(selections).length
  const allSelected = selectedCount >= total

  // 目标歌曲模板（固定参数，供高亮比对与展示）
  const target: TargetTrackTemplate = { title: choice.query.title, artist: choice.query.artist }

  const handlePick = (songId: string) => {
    log.info('confirm.pick', '选择候选版本', {
      title: choice.query.title,
      songId,
    })
    onSelect(current, songId)
    // 选完自动进入下一首（最后一首停留等待确认）
    if (current < total - 1) setCurrent((c) => Math.min(c + 1, total - 1))
  }

  const handlePrevious = () => {
    log.debug('confirm.previous', '回看上一首', { index: current })
    setCurrent((c) => Math.max(0, c - 1))
  }

  return (
    <div className="dialog-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="dialog-panel-enter flex h-[32rem] max-h-[85vh] w-[36rem] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container">
        {confirmResult ? (
          // --- 完成态：同步结果摘要 ---
          <div className="p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">task_alt</span>
              <p className="font-body-md text-body-md font-medium">{t('textCreator.syncDone')}</p>
            </div>
            <p className="mt-2 font-label-md text-label-md text-on-surface">
              {t('textCreator.syncDoneDetail', {
                added: confirmResult.added,
                total: confirmResult.total,
                name: confirmResult.playlistName,
              })}
            </p>
            {confirmResult.failed.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto font-label-sm text-label-sm text-error">
                {failedDetailLines(confirmResult.failed).map((line, i) => (
                  <li key={i}>· {line}</li>
                ))}
              </ul>
            )}
            <button
              onClick={onDone}
              className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85"
            >
              <span className="material-symbols-outlined text-sm">check</span>
              {t('confirmDialog.done')}
            </button>
          </div>
        ) : (
          // --- 选择态：头部与底部固定，仅候选区域滚动 ---
          <>
            <div className="flex items-center justify-between border-b border-outline-variant px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-tertiary">playlist_add_check</span>
                <p className="font-body-md text-body-md font-medium">{t('confirmDialog.title')}</p>
              </div>
              <div className="flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
                <span>
                  {t('confirmDialog.step', { current: current + 1, total })}
                </span>
                <span className="mx-1 h-3 w-px bg-outline-variant" />
                <span>{t('confirmDialog.selected', { selected: selectedCount, total })}</span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {/* 目标歌曲（用户歌单里的歌名与歌手） */}
              <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
                <p className="font-label-mono text-label-mono text-outline">TARGET TRACK</p>
                <p className="mt-1 font-body-md text-body-md font-medium">{target.title}</p>
                {target.artist && (
                  <p className="font-label-md text-label-md text-on-surface-variant">
                    {target.artist}
                  </p>
                )}
              </div>

              <p className="mt-4 font-label-sm text-label-sm text-on-surface-variant">
                {t('confirmDialog.pickHint')}
              </p>

              {/* 候选版本列表：按固定模板渲染（封面 + 歌名 + 歌手 + 专辑 + 时长） */}
              <ul className="mt-2 space-y-2">
                {choice.candidates.map((c) => (
                  <li key={c.id}>
                    <CandidateCard
                      candidate={c}
                      target={target}
                      selected={selections[current] === c.id}
                      onPick={handlePick}
                    />
                  </li>
                ))}
              </ul>
            </div>

            {/* 底部操作：上一首 / 取消 / 确认 */}
            <div className="flex items-center gap-2 border-t border-outline-variant px-5 py-3">
              <button
                onClick={handlePrevious}
                disabled={current === 0 || confirming}
                className="flex items-center gap-1 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-sm">arrow_back</span>
                {t('confirmDialog.previous')}
              </button>
              <button
                onClick={onCancel}
                disabled={confirming}
                className="flex items-center gap-1 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-sm">close</span>
                {t('textCreator.cancelPending')}
              </button>
              <button
                onClick={onConfirm}
                disabled={confirming || !allSelected}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-sm">
                  {confirming ? 'progress_activity' : 'task_alt'}
                </span>
                {confirming ? t('confirmDialog.confirming') : t('textCreator.confirmAndCreate')}
              </button>
            </div>

            {confirmError && (
              <p className="border-t border-outline-variant px-5 py-2 font-label-sm text-label-sm text-error">
                {confirmError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
