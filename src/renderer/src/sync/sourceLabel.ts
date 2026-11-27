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

const PLAYLIST_IMPORT_PREFIX = 'playlist-import:'

/**
 * 平台歌单导入任务的来源平台 id（格式 `playlist-import:<platformId>`）；
 * 旧任务（无平台信息，值为 `playlist-import`）返回 null，展示兜底为「歌单导入」。
 */
export function sourcePlatformId(source: string): string | null {
  if (!source.startsWith(PLAYLIST_IMPORT_PREFIX)) return null
  return source.slice(PLAYLIST_IMPORT_PREFIX.length) || null
}
