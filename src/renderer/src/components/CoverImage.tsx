import { useEffect, useState } from 'react'
import { toHttpsCover } from '../utils/coverUrl'

type CoverSize = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<CoverSize, { image: string; fallback: string; icon: string }> = {
  sm: {
    image: 'h-8 w-8 rounded-md object-cover',
    fallback: 'flex h-8 w-8 items-center justify-center rounded-md bg-surface-container-high text-outline',
    icon: 'text-base',
  },
  md: {
    image: 'h-9 w-9 shrink-0 rounded-md object-cover',
    fallback:
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-outline',
    icon: 'text-lg',
  },
  lg: {
    image: 'h-14 w-14 shrink-0 rounded-md object-cover',
    fallback:
      'flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-surface-container-highest',
    icon: 'text-2xl',
  },
}

interface CoverImageProps {
  src?: string
  alt: string
  size?: CoverSize
  fallbackIcon?: 'queue_music' | 'music_note'
  /** 候选对比卡片需要空 Referer 防止上游防盗链拦截 */
  noReferrer?: boolean
}

/** 统一封面：https 兜底 + 加载失败回退图标；URL 变化时重置失败态 */
export default function CoverImage({
  src,
  alt,
  size = 'sm',
  fallbackIcon = 'queue_music',
  noReferrer = false,
}: CoverImageProps) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const cls = SIZE_CLASS[size]
  if (!src || failed) {
    return (
      <span className={`${cls.fallback} shrink-0`}>
        <span className={`material-symbols-outlined ${cls.icon}`}>{fallbackIcon}</span>
      </span>
    )
  }
  return (
    <img
      src={toHttpsCover(src)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      referrerPolicy={noReferrer ? 'no-referrer' : undefined}
      className={cls.image}
    />
  )
}
