import { useEffect, useState } from 'react'
import ProgressBar from './ProgressBar'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  /** 业务 key：同 key 的 show 更新既有卡片（任务进度更新不堆叠新通知） */
  key?: string
  type: ToastType
  title: string
  detail?: string
  /** 自动消失时长（ms）；persistent 卡片忽略 */
  duration: number
  leaving: boolean
  /** 任务进度（0~1）：提供时渲染进度条 */
  progress?: number
  /** 进度条下方文字 */
  progressLabel?: string
  /** 持久卡片：不自动消失，由 closeTaskToast 关闭 */
  persistent?: boolean
  /** 卡片尾部操作按钮（如任务停止） */
  action?: { label: string; onClick: () => void }
}

type ToastEvent =
  | { kind: 'show'; toast: ToastItem }
  | { kind: 'close'; id: number }

type Listener = (event: ToastEvent) => void

let seq = 0
const listeners = new Set<Listener>()
/** 同屏最多堆叠条数，超出时挤掉最旧一条 */
const MAX_VISIBLE = 4

/** 持久任务卡片：业务 key → 卡片 id（关闭后同步清理） */
const taskCardIds = new Map<string, number>()

/**
 * 全局通知入口（模块级，无需 Provider）：
 * notify('success', '同步完成', '12/12 首已写入「我的歌单」')
 */
export function notify(type: ToastType, title: string, detail?: string): void {
  show({
    id: ++seq,
    type,
    title,
    detail,
    duration: type === 'error' ? 6000 : detail ? 5500 : 4000,
    leaving: false,
  })
}

/**
 * 展示/更新持久任务卡片（同步任务进度/停止操作）：
 * 同一 key 复用同一张卡片，进度更新不堆叠；任务结束时 closeTaskToast 关闭。
 */
export function notifyTask(
  key: string,
  opts: {
    type?: ToastType
    title: string
    detail?: string
    progress?: number
    progressLabel?: string
    action?: { label: string; onClick: () => void }
  },
): void {
  const toast: ToastItem = {
    id: taskCardIds.get(key) ?? ++seq,
    key,
    type: opts.type ?? 'info',
    title: opts.title,
    detail: opts.detail,
    duration: 0,
    leaving: false,
    progress: opts.progress,
    progressLabel: opts.progressLabel,
    persistent: true,
    action: opts.action,
  }
  taskCardIds.set(key, toast.id)
  show(toast)
}

/** 关闭任务卡片（任务消失/汇总切换时移除，不产生结果通知） */
export function closeTaskToast(key: string): void {
  const id = taskCardIds.get(key)
  if (id === undefined) return
  taskCardIds.delete(key)
  close(id)
}

/**
 * 任务结束：持久任务卡「原地」更新为结果通知（复用卡片 id，不关旧卡另弹新卡），
 * 随后自动消失。卡片已被用户手动关闭时静默——执行结束不再弹新窗口。
 */
export function finishTaskToast(
  key: string,
  opts: { type: ToastType; title: string; detail?: string },
): void {
  const id = taskCardIds.get(key)
  if (id === undefined) return
  taskCardIds.delete(key)
  show({
    id,
    type: opts.type,
    title: opts.title,
    detail: opts.detail,
    duration: opts.type === 'error' ? 6000 : opts.detail ? 5500 : 4000,
    leaving: false,
  })
}

function show(toast: ToastItem): void {
  listeners.forEach((l) => l({ kind: 'show', toast }))
}

function close(id: number): void {
  listeners.forEach((l) => l({ kind: 'close', id }))
}

const ICONS: Record<ToastType, string> = {
  success: 'check_circle',
  error: 'error',
  warning: 'warning',
  info: 'progress_activity',
}

const CARD_STYLE: Record<ToastType, string> = {
  success: 'border-primary/40',
  error: 'border-error/50',
  warning: 'border-amber-300/40',
  info: 'border-tertiary/40',
}

const ICON_STYLE: Record<ToastType, string> = {
  success: 'text-primary',
  error: 'text-error',
  warning: 'text-amber-300',
  // 运行中图标旋转（progress_activity 需 animate-spin 才有转圈效果）
  info: 'text-tertiary animate-spin',
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem
  onDismiss: (id: number) => void
}) {
  useEffect(() => {
    // 持久任务卡片不自动消失，等任务结束由逻辑层关闭
    if (toast.leaving || toast.persistent) return
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration)
    return () => clearTimeout(timer)
  }, [toast.id, toast.persistent])

  return (
    <div
      role="status"
      className={`pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-surface-container p-3 shadow-lg shadow-black/40 ${
        CARD_STYLE[toast.type]
      } ${toast.leaving ? 'toast-leave' : 'toast-enter'}`}
    >
      <span
        className={`material-symbols-outlined mt-0.5 text-lg ${ICON_STYLE[toast.type]}`}
      >
        {ICONS[toast.type]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-label-md text-label-md font-medium text-on-surface">{toast.title}</p>
        {toast.detail && (
          <p className="mt-0.5 break-words font-body-md text-body-md text-on-surface-variant">
            {toast.detail}
          </p>
        )}
        {toast.progress !== undefined && (
          <div className="mt-2">
            <ProgressBar ratio={toast.progress} label={toast.progressLabel} />
          </div>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => toast.action!.onClick()}
          title={toast.action.label}
          aria-label={toast.action.label}
          className="shrink-0 rounded-md p-0.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
        >
          <span className="material-symbols-outlined text-base">stop</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="close"
        className="shrink-0 text-outline transition-colors hover:text-on-surface"
      >
        <span className="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  )
}

/** 右上角通知堆栈：挂载在 App 根部，任意组件经 notify()/notifyTask() 触发 */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    const listener: Listener = (event) => {
      if (event.kind === 'close') {
        dismiss(event.id)
        return
      }
      const toast = event.toast
      setToasts((prev) => {
        // 同 key 更新既有卡片（任务进度更新）；key 未命中时按 id 匹配
        // （任务卡原地转结果通知复用同 id），均未命中才追加
        let idx = -1
        if (toast.key !== undefined) {
          idx = prev.findIndex((t) => t.key === toast.key)
        }
        if (idx === -1) {
          idx = prev.findIndex((t) => t.id === toast.id)
        }
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = toast
          return next
        }
        return [...prev.slice(-(MAX_VISIBLE - 1)), toast]
      })
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const dismiss = (id: number) => {
    // 持久任务卡被用户手动关闭后，任务结束不再原地复活结果通知（执行结束不弹新窗口）
    for (const [key, cardId] of taskCardIds) {
      if (cardId === id) taskCardIds.delete(key)
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id && !t.leaving ? { ...t, leaving: true } : t)),
    )
    // 退出动画播完再从堆栈移除（与 toast-leave 0.25s 时长一致）
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 250)
  }

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}
