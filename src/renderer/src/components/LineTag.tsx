import { useI18n } from '../i18n'

interface EditInputProps {
  value: string
  /** 与被替换文本等宽，避免布局重排引起页面跳动 */
  width: number
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}

/** 原位编辑框：继承 tag 字体与行高，零边框零内边距，宽度与原文一致 */
function EditInput({ value, width, onChange, onCommit, onCancel }: EditInputProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit()
        if (e.key === 'Escape') onCancel()
      }}
      ref={(el) => {
        // 仅首次聚焦，且禁止滚动：聚焦不应引起页面跳动
        if (el && document.activeElement !== el) {
          el.focus({ preventScroll: true })
        }
      }}
      style={{ width }}
      className="m-0 min-w-8 max-w-56 border-0 bg-surface p-0 font-label-md text-label-md text-on-surface caret-primary outline-none [font-family:inherit]"
    />
  )
}

export type LineTagKind = 'song' | 'failed' | 'ignored' | 'raw'

/** 各类 tag 的容器样式（song 的 dup 样式单独定义） */
const CONTAINER_CLASS: Record<LineTagKind, string> = {
  song: 'border-primary/40 bg-primary/10 text-on-surface',
  failed: 'border-error/50 bg-error/10 text-error',
  ignored: 'border-outline-variant bg-surface-container-high/40 text-outline',
  raw: 'border-outline-variant bg-surface-container-high text-on-surface-variant',
}
const CONTAINER_CLASS_DUP =
  'border-outline-variant bg-surface-container-high/60 text-on-surface-variant'

const ICON: Record<LineTagKind, string> = {
  song: 'music_note',
  failed: 'error_outline',
  ignored: 'filter_alt_off',
  raw: '',
}

const TEXT_CLASS: Record<LineTagKind, string> = {
  song: 'hover:text-primary hover:underline',
  failed: 'hover:underline',
  ignored: 'line-through hover:text-on-surface',
  raw: 'hover:text-on-surface hover:underline',
}

interface LineTagProps {
  kind: LineTagKind
  /** 展示文本（歌曲为歌名，其余为原始行） */
  text: string
  /** 歌曲标签的歌手副文本 */
  subtitle?: string
  /** 重复歌曲：灰调 + 重复标记 */
  dup?: boolean
  /** 容器 title 提示 */
  tooltip?: string
  /** 原始行文本（song 的编辑按钮 title 用） */
  raw?: string
  /** 是否可原位编辑（extraSongs 为 false） */
  editable?: boolean
  editing?: boolean
  editingText?: string
  editingWidth?: number
  onEditingChange?: (v: string) => void
  onStartEdit?: (width: number) => void
  onCommitEdit?: () => void
  onCancelEdit?: () => void
  onRemove: () => void
}

/** 输入区单行 tag：song/failed/ignored/raw 共用（编辑 + 删除 + 重复标记） */
export default function LineTag({
  kind,
  text,
  subtitle,
  dup = false,
  tooltip,
  raw,
  editable = true,
  editing = false,
  editingText = '',
  editingWidth = 0,
  onEditingChange,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onRemove,
}: LineTagProps) {
  const { t } = useI18n()
  const container = kind === 'song' && dup ? CONTAINER_CLASS_DUP : CONTAINER_CLASS[kind]
  const icon = ICON[kind]
  const iconStyle = kind === 'song' ? (dup ? 'text-outline' : 'text-primary') : ''
  const textStyle =
    kind === 'song' && dup ? 'hover:text-on-surface hover:underline' : TEXT_CLASS[kind]

  const subtitleNode = subtitle && (
    <span className={dup ? 'text-outline' : 'text-on-surface-variant'}> · {subtitle}</span>
  )

  const content =
    editing && editable && onEditingChange && onCommitEdit && onCancelEdit ? (
      <EditInput
        value={editingText}
        width={editingWidth}
        onChange={onEditingChange}
        onCommit={onCommitEdit}
        onCancel={onCancelEdit}
      />
    ) : editable ? (
      <button
        type="button"
        onClick={(e) => onStartEdit?.(e.currentTarget.offsetWidth)}
        title={
          kind === 'song'
            ? `${raw ?? text}（${t('textCreator.editHint')}）`
            : kind === 'ignored'
              ? t('textCreator.ignoredLine')
              : undefined
        }
        className={`max-w-56 cursor-text truncate transition-colors ${textStyle}`}
      >
        {text}
        {subtitleNode}
      </button>
    ) : (
      <span className="max-w-56 truncate">
        {text}
        {subtitleNode}
      </span>
    )

  return (
    <span
      title={tooltip}
      className={`group inline-flex max-w-full items-center gap-1 rounded-lg border px-2.5 py-1.5 font-label-md text-label-md ${container}`}
    >
      {dup && (
        <span
          title={t('textCreator.duplicateHint')}
          className="flex items-center rounded bg-outline-variant/60 p-0.5 text-on-surface-variant"
        >
          <span className="material-symbols-outlined text-xs">content_copy</span>
        </span>
      )}
      {icon && <span className={`material-symbols-outlined text-sm ${iconStyle}`}>{icon}</span>}
      {content}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="material-symbols-outlined text-sm text-outline transition-colors hover:text-error"
      >
        close
      </button>
    </span>
  )
}
