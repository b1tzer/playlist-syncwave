import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

interface DragState {
  anchorId: string
  startX: number
  startY: number
  moved: boolean
}

/**
 * 歌单列表多选：Cmd/Ctrl 点选切换、按下拖动 5px 后按经过行整段框选。
 * 平台歌单与本地歌单共用同一套交互，orderedIds 为当前可见行的顺序。
 */
export function usePlaylistMultiSelect(orderedIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const dragRef = useRef<DragState | null>(null)
  /** 拖拽结束后同一行释放会触发 click，抑制一次避免撤销框选 */
  const suppressClickRef = useRef(false)
  const idsRef = useRef(orderedIds)
  idsRef.current = orderedIds

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag || drag.moved) return
      if (Math.abs(e.clientX - drag.startX) > 5 || Math.abs(e.clientY - drag.startY) > 5) {
        drag.moved = true
        setSelectedIds(new Set([drag.anchorId]))
      }
    }
    const onUp = () => {
      const wasDrag = dragRef.current?.moved ?? false
      dragRef.current = null
      if (wasDrag) {
        suppressClickRef.current = true
        setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const selectRange = (anchorId: string, endId: string): Set<string> => {
    const ids = idsRef.current
    const from = ids.indexOf(anchorId)
    const to = ids.indexOf(endId)
    if (from === -1 || to === -1) return new Set([anchorId])
    const [start, end] = from < to ? [from, to] : [to, from]
    return new Set(ids.slice(start, end + 1))
  }

  const handleRowMouseDown = (e: ReactMouseEvent, id: string) => {
    if (e.button !== 0) return
    dragRef.current = { anchorId: id, startX: e.clientX, startY: e.clientY, moved: false }
  }
  const handleRowMouseEnter = (id: string) => {
    const drag = dragRef.current
    if (!drag?.moved) return
    setSelectedIds(selectRange(drag.anchorId, id))
  }
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())
  /** 行 click 中消费一次拖拽抑制标记 */
  const consumeSuppressedClick = () => {
    if (!suppressClickRef.current) return false
    suppressClickRef.current = false
    return true
  }

  return {
    selectedIds,
    setSelectedIds,
    toggleSelect,
    clearSelection,
    handleRowMouseDown,
    handleRowMouseEnter,
    consumeSuppressedClick,
  }
}
