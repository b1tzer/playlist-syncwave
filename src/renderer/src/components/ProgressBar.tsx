interface ProgressBarProps {
  /** 0~1 进度 */
  ratio: number
  /** 条下方的说明文本 */
  label?: React.ReactNode
}

/** 通用进度条（同步中心 / 快速创建 / 歌单同步共用） */
export default function ProgressBar({ ratio, label }: ProgressBarProps) {
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      {label && (
        <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">{label}</p>
      )}
    </div>
  )
}
