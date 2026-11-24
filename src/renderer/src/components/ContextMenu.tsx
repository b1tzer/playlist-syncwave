import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 菜单条目：item 或分隔线（divider 仅作视觉分组，不参与键盘导航） */
export type ContextMenuEntry =
  | { type: 'divider'; id: string }
  | {
      type: 'item'
      id: string
      label: string
      icon?: string
      iconNode?: ReactNode
      danger?: boolean
      disabled?: boolean
      onSelect?: () => void
    }

interface ContextMenuProps {
  open: boolean
  x: number
  y: number
  ariaLabel: string
  entries: ContextMenuEntry[]
  onClose: () => void
}

const VIEWPORT_MARGIN = 8

/**
 * 通用右键菜单：
 * - 视口边缘翻转定位（useLayoutEffect 实测尺寸，绘制前修正，无闪烁）
 * - 关闭：点击外部 / Escape / 滚动（capture）/ 窗口缩放 / 失焦
 * - 键盘导航：上下键循环、Home/End，禁用项跳过；Enter/Space 原生触发按钮
 * - 焦点管理：打开聚焦首项，关闭还原触发元素
 * - ARIA：role=menu/menuitem + aria-label
 * - 菜单内右键阻止系统菜单；空条目列表不渲染
 */
export default function ContextMenu({ open, x, y, ariaLabel, entries, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState({ x, y })
  const [activeIndex, setActiveIndex] = useState(0)

  const items = entries.filter(
    (e): e is Extract<ContextMenuEntry, { type: 'item' }> => e.type === 'item',
  )

  // 打开时：实测尺寸做视口翻转定位；记录打开前焦点并聚焦首项
  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (nx + rect.width > window.innerWidth - VIEWPORT_MARGIN) {
      nx = Math.max(VIEWPORT_MARGIN, nx - rect.width)
    }
    if (ny + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      ny = Math.max(VIEWPORT_MARGIN, ny - rect.height)
    }
    setPos({ x: nx, y: ny })
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    el.querySelector<HTMLButtonElement>('button[data-menu-item]:not(:disabled)')?.focus()
    setActiveIndex(0)
  }, [open, x, y])

  // 关闭时还原焦点
  useEffect(() => {
    if (open) return
    restoreFocusRef.current?.focus()
    restoreFocusRef.current = null
  }, [open])

  // 外部交互关闭（scroll 不冒泡，必须 capture 才能捕获内部滚动容器的滚动）
  useEffect(() => {
    if (!open) return
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open, onClose])

  if (!open || items.length === 0) return null

  const focusItemAt = (index: number) => {
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button[data-menu-item]')
    buttons?.[index]?.focus()
    setActiveIndex(index)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    let next = activeIndex
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'ArrowDown') next = (activeIndex + 1) % items.length
    else next = (activeIndex - 1 + items.length) % items.length
    let guard = 0
    while (items[next].disabled && guard < items.length) {
      next = e.key === 'ArrowUp' ? (next - 1 + items.length) % items.length : (next + 1) % items.length
      guard++
    }
    focusItemAt(next)
  }

  let itemIndex = -1
  // Portal 挂载到 body：避开任何 transform/overflow 祖先，fixed 定位始终相对视口
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 max-h-[80vh] w-56 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container p-1 shadow-[0_4px_16px_var(--sw-menu-shadow)]"
    >
      {entries.map((entry) => {
        if (entry.type === 'divider') {
          return <div key={entry.id} className="my-1 h-px bg-outline-variant" />
        }
        itemIndex += 1
        const idx = itemIndex
        const highlight = idx === activeIndex && !entry.disabled
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            data-menu-item
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect?.()
            }}
            onMouseEnter={() => setActiveIndex(idx)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-label-md text-label-md transition-colors focus:outline-none disabled:opacity-40 ${
              entry.danger
                ? `text-error hover:bg-error/10 ${highlight ? 'bg-error/10' : ''}`
                : `text-on-surface hover:bg-surface-container-high ${highlight ? 'bg-surface-container-high' : ''}`
            }`}
          >
            {entry.iconNode ??
              (entry.icon && (
                <span className="material-symbols-outlined text-base">{entry.icon}</span>
              ))}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
