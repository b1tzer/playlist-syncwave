import type { Translate } from './helpers'

/**
 * 任务来源 → 展示文案（同步历史行与任务中心共用）。
 * 已知来源走翻译字典；未知来源原样透出，保证未来新增来源有兜底显示。
 */
export function syncSourceLabel(source: string, t: Translate): string {
  switch (source) {
    case 'text-import':
      return t('syncHistory.sourceTextImport')
    case 'playlist-import':
      return t('syncHistory.sourcePlaylistImport')
    case 'local-playlist':
      return t('syncHistory.sourceLocalPlaylist')
    default:
      return source
  }
}

/** 来源是否为本应用的「本地歌单」概念：显示时使用应用 logo 而非通用图标 */
export function isLocalSource(source: string): boolean {
  return source === 'local-playlist'
}
