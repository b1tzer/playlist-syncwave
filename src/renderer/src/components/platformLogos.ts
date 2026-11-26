import netease from '@renderer/assets/music_logos/netease.svg'
import qqmusic from '@renderer/assets/music_logos/qqmusic.svg'
import kugou from '@renderer/assets/music_logos/kugou.png'
import kuwo from '@renderer/assets/music_logos/kuwo.png'
import migu from '@renderer/assets/music_logos/migu.png'
import applemusic from '@renderer/assets/music_logos/applemusic.svg'
import appIcon from '@renderer/assets/app-icon.svg'

/** 平台 id → 品牌 logo 资源（未收录的平台回退 material-symbols 图标）。
 *  `local` 为应用自身 logo：本地歌单/「同步到本地」等本应用概念统一使用。 */
export const PLATFORM_LOGOS: Record<string, string> = {
  local: appIcon,
  netease,
  qqmusic,
  kugou,
  kuwo,
  migu,
  applemusic,
}
