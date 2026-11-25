import { getDatabase } from './appDatabase'
import type { SettingsValue } from './settingsStore'
import { SYNC_TUNING_DEFAULTS, SYNC_TUNING_RANGE, type SyncTuning } from '@core/sync/tuning'

export function getSetting<T extends SettingsValue>(key: string, fallback: T): T {
  return getDatabase().settings.get(key, fallback)
}

export function setSetting(key: string, value: SettingsValue): void {
  getDatabase().settings.set(key, value)
}

export function getAllSettings(): Record<string, SettingsValue> {
  return getDatabase().settings.all()
}

/** 主进程侧设置默认值（渲染层各自模块内另有同值常量，键语义以这里为准） */
export const SETTINGS_DEFAULTS = {
  theme: 'dark',
  language: 'zh-CN',
  autoUpdateEnabled: true,
  proxyUrl: '',
} as const

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 同步引擎调优参数（设置页可配置，越界回退默认值）。
 * 默认值与取值范围来自 @core/sync/tuning 单一事实源，引擎层同源引用。
 */
export function syncTuning(): SyncTuning {
  return {
    threshold: clamp(
      getSetting<number>('syncThreshold', SYNC_TUNING_DEFAULTS.threshold),
      SYNC_TUNING_RANGE.threshold.min,
      SYNC_TUNING_RANGE.threshold.max,
    ),
    searchRetries: clamp(
      getSetting<number>('syncRetries', SYNC_TUNING_DEFAULTS.searchRetries),
      SYNC_TUNING_RANGE.searchRetries.min,
      SYNC_TUNING_RANGE.searchRetries.max,
    ),
    searchIntervalMs: clamp(
      getSetting<number>('syncSearchInterval', SYNC_TUNING_DEFAULTS.searchIntervalMs),
      SYNC_TUNING_RANGE.searchIntervalMs.min,
      SYNC_TUNING_RANGE.searchIntervalMs.max,
    ),
  }
}
