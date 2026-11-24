import { PLATFORM_LOGOS } from './platformLogos'

interface PlatformLogoProps {
  /** 平台 id（对应 PLATFORM_LOGOS 键） */
  platform: string
  /** 平台展示名（img alt） */
  name: string
  /** material-symbols 图标名（无 logo 资源时回退） */
  icon: string
  /** 尺寸类，默认 h-5 w-5 */
  size?: string
  /** 图标字号类 */
  iconSize?: string
}

/** 平台品牌 logo（未收录的平台回退 material-symbols 图标） */
export default function PlatformLogo({
  platform,
  name,
  icon,
  size = 'h-5 w-5',
  iconSize = 'text-base',
}: PlatformLogoProps) {
  const src = PLATFORM_LOGOS[platform]
  return src ? (
    <img src={src} alt={name} className={`${size} object-contain`} />
  ) : (
    <span className={`material-symbols-outlined ${iconSize}`}>{icon}</span>
  )
}
