import { normalize } from '@core/matcher/matchSong'
import type { SyncFailedItem } from '@core/models/sync'
import type { TranslationKey, TranslateParams } from '../i18n/translations'

export type Translate = (key: TranslationKey, params?: TranslateParams) => string

/** 歌曲去重键：标题+歌手归一化（与匹配引擎同口径） */
export function songDupKey(s: { title: string; artist?: string }): string {
  return `${normalize(s.title)}|${normalize(s.artist ?? '')}`
}

/** 失败条目标题：歌名 - 歌手 */
export function syncItemTitle(q: { title: string; artist?: string }): string {
  return `${q.title}${q.artist ? ` - ${q.artist}` : ''}`
}

/** 同步失败条目按稳定 reason 码翻译；平台原始错误直接透传 */
export function syncFailedText(t: Translate, f: SyncFailedItem): string {
  const title = syncItemTitle(f.query)
  switch (f.reason) {
    case 'no-match':
      return t('sync.failedNoMatch', { title })
    case 'unresolved':
      return t('sync.failedUnresolved', { title })
    case 'rate-limited':
      return t('sync.failedRateLimited')
    default:
      return f.message
  }
}

/** 失败明细行：`歌名 - 歌手（原因）` */
export function failedDetailLines(failed: SyncFailedItem[]): string[] {
  return failed.map((f) => `${syncItemTitle(f.query)}（${f.message}）`)
}

/** 毫秒时长 → m:ss；缺省显示 -- */
export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '--'
  const totalSec = Math.round(durationMs / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
