import { getDatabase } from './appDatabase'
import type { SettingsValue } from './settingsStore'

export function getSetting<T extends SettingsValue>(key: string, fallback: T): T {
  return getDatabase().settings.get(key, fallback)
}

export function setSetting(key: string, value: SettingsValue): void {
  getDatabase().settings.set(key, value)
}

export function getAllSettings(): Record<string, SettingsValue> {
  return getDatabase().settings.all()
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 同步引擎调优参数（设置页可配置，越界回退默认值） */
export function syncTuning(): { threshold: number; searchRetries: number; searchIntervalMs: number } {
  return {
    threshold: clamp(getSetting<number>('syncThreshold', 0.6), 0.4, 0.9),
    searchRetries: clamp(getSetting<number>('syncRetries', 2), 0, 5),
    searchIntervalMs: clamp(getSetting<number>('syncSearchInterval', 500), 300, 3000),
  }
}
