/** 设置项数据库接口（与 syncHistoryStore 相同的抽象） */
export interface SettingsDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): unknown
}

export type SettingsValue = string | number | boolean

interface SettingRow {
  key: string
  value: string
}

function decode(raw: string): SettingsValue {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const num = Number(raw)
  if (raw !== '' && Number.isFinite(num) && String(num) === raw) return num
  return raw
}

function encode(value: SettingsValue): string {
  if (typeof value === 'boolean') return String(value)
  return String(value)
}

export function createSettingsStore(db: SettingsDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
`)

  return {
    /** 读取设置项，无记录时回退默认值 */
    get<T extends SettingsValue>(key: string, fallback: T): T {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
        | SettingRow
        | undefined
      if (!row) return fallback
      return decode(row.value) as T
    },

    set(key: string, value: SettingsValue): void {
      db.prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, encode(value))
    },

    remove(key: string): void {
      db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
    },

    all(): Record<string, SettingsValue> {
      const rows = db.prepare('SELECT key, value FROM app_settings').all() as SettingRow[]
      return Object.fromEntries(rows.map((r) => [r.key, decode(r.value)]))
    },
  }
}

export type SettingsStore = ReturnType<typeof createSettingsStore>
