import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  /** 锚点：目标元素底边中心（视口坐标），提示默认显示在锚点下方 */
  x: number
  y: number
  text: string
}

const EDGE = 8

/**
 * 悬浮即时提示：Portal 挂载 body 规避滚动容器裁剪；
 * 原生 title 提示延迟过久（禁用元素延迟更长），悬浮反馈不及时。
 * 默认显示在锚点下方，底部空间不足时翻转到上方，水平方向夹在视口内。
 */
export default function Tooltip({ x, y, text }: TooltipProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0, visible: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const below = y + rect.height + EDGE <= window.innerHeight
    const nx = Math.max(EDGE, Math.min(x - rect.width / 2, window.innerWidth - rect.width - EDGE))
    setPos({
      x: nx,
      y: below ? y + EDGE : y - rect.height - EDGE,
      visible: true,
    })
  }, [x, y, text])

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={`pointer-events-none fixed z-50 rounded-md border border-outline-variant bg-surface-container-highest px-2.5 py-1 font-label-sm text-label-sm text-on-surface shadow-[0_4px_16px_var(--sw-menu-shadow)] ${
        pos.visible ? '' : 'invisible'
      }`}
      style={{ left: pos.x, top: pos.y }}
    >
      {text}
    </div>,
    document.body,
  )
}
