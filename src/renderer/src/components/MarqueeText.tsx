import { useRef, useState } from 'react'

/** 超长文本：默认省略号截断，悬浮时自动来回滚动展示全文。
 *  外层是 flex 裁剪容器（overflow-hidden 挡住滚动文字，不溢出到封面/数字），
 *  内层 block 做省略号与 translateX 动画；flex 布局避免 inline-block 基线空隙。 */
export default function MarqueeText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0)
  const [duration, setDuration] = useState(6)
  const [hovered, setHovered] = useState(false)

  // 只在真正悬浮时测一次宽度：每行一个 ResizeObserver 会在窗口拉伸时产生数百次回调与 setState
  const handleMouseEnter = () => {
    const el = ref.current
    if (el) {
      const distance = Math.max(0, el.scrollWidth - el.clientWidth)
      setShift(distance)
      setDuration(Math.min(12, Math.max(2.5, distance / 17.5)))
    }
    setHovered(true)
  }

  const scrolling = hovered && shift > 0

  return (
    <span
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setHovered(false)}
      className={`flex min-w-0 items-center overflow-hidden ${className ?? ''}`}
    >
      <span
        ref={ref}
        className={`max-w-full whitespace-nowrap ${
          scrolling ? 'marquee-x' : 'overflow-hidden text-ellipsis'
        }`}
        style={
          scrolling
            ? {
                ['--marquee-shift' as string]: `-${shift}px`,
                animationDuration: `${duration}s`,
              }
            : undefined
        }
      >
        {text}
      </span>
    </span>
  )
}
