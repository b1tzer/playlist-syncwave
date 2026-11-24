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
