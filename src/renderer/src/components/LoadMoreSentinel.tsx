import { useEffect, useRef } from 'react'

interface LoadMoreSentinelProps {
  /** 哨兵进入可视区域时触发（滚动分页加载更多） */
  onVisible: () => void
  enabled?: boolean
  /** 提前触发距离：哨兵进入「可视区域外扩 margin」即触发，滚动接近底部就预取下一页 */
  rootMargin?: string
}

/**
 * 无限滚动哨兵：占位元素进入可视区域即触发加载更多。
 * 放在滚动列表末尾；enabled=false 时不监听。
 */
export default function LoadMoreSentinel({
  onVisible,
  enabled = true,
  rootMargin = '200px 0px 0px 0px',
}: LoadMoreSentinelProps) {
  const ref = useRef<HTMLDivElement>(null)
  // 始终引用最新回调，避免 onVisible 变化时重建 observer
  const callbackRef = useRef(onVisible)
  callbackRef.current = onVisible

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callbackRef.current()
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [enabled, rootMargin])

  return <div ref={ref} aria-hidden="true" className="h-px" />
}
