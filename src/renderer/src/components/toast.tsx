import { useEffect, useState } from 'react'

export type ToastType = 'success' | 'error' | 'warning'

export interface ToastItem {
  id: number
  type: ToastType
  title: string
  detail?: string
  /** 自动消失时长（ms） */
  duration: number
  leaving: boolean
}

type Listener = (toast: ToastItem) => void

let seq = 0
const listeners = new Set<Listener>()
/** 同屏最多堆叠条数，超出时挤掉最旧一条 */
const MAX_VISIBLE = 4

/**
 * 全局通知入口（模块级，无需 Provider）：
 * notify('success', '同步完成', '12/12 首已写入「我的歌单」')
 */
export function notify(type: ToastType, title: string, detail?: string): void {
  const toast: ToastItem = {
    id: ++seq,
    type,
    title,
    detail,
    duration: type === 'error' ? 6000 : detail ? 5500 : 4000,
    leaving: false,
  }
  listeners.forEach((l) => l(toast))
}

const ICONS: Record<ToastType, string> = {
  success: 'check_circle',
  error: 'error',
  warning: 'warning',
}

const CARD_STYLE: Record<ToastType, string> = {
  success: 'border-primary/40',
  error: 'border-error/50',
  warning: 'border-amber-300/40',
}

const ICON_STYLE: Record<ToastType, string> = {
  success: 'text-primary',
  error: 'text-error',
  warning: 'text-amber-300',
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem
  onDismiss: (id: number) => void
}) {
  useEffect(() => {
    if (toast.leaving) return
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration)
    return () => clearTimeout(timer)
  }, [toast.id])

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
      </div>
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

/** 右上角通知堆栈：挂载在 App 根部，任意组件经 notify() 触发 */
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    const listener: Listener = (toast) => {
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), toast])
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const dismiss = (id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id && !t.leaving ? { ...t, leaving: true } : t)),
    )
    // 退出动画播完再从堆栈移除
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 220)
  }

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  )
}
