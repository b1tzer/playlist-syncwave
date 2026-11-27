import type { EncyclopediaKind } from '@core/models/encyclopedia'
import type { SqliteDb } from './sqlite'

/** 「名字 → 实体 id」纠偏映射记录（用户点选候选后写入，下次点击直达） */
export interface EncyclopediaMapping {
  platform: string
  kind: EncyclopediaKind
  name: string
  entityId: string
  entityName: string
  createdAt: string
}

interface MappingRow {
  platform: string
  kind: string
  name: string
  entity_id: string
  entity_name: string
  created_at: string
}

function rowToMapping(row: MappingRow): EncyclopediaMapping {
  return {
    platform: row.platform,
    kind: row.kind as EncyclopediaKind,
    name: row.name,
    entityId: row.entity_id,
    entityName: row.entity_name,
    createdAt: row.created_at,
  }
}

export function createEncyclopediaStore(db: SqliteDb) {
  db.exec(`
CREATE TABLE IF NOT EXISTS encyclopedia_entity_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(platform, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_encyclopedia_mappings_lookup
  ON encyclopedia_entity_mappings (platform, kind, name);
`)

  return {
    /** 查询已确认的映射；无记录返回 null */
    find(platform: string, kind: EncyclopediaKind, name: string): EncyclopediaMapping | null {
      const row = db
        .prepare(
          `SELECT * FROM encyclopedia_entity_mappings
           WHERE platform = ? AND kind = ? AND name = ?`,
        )
        .get(platform, kind, name) as unknown as MappingRow | undefined
      return row ? rowToMapping(row) : null
    },

    /** 写入/覆盖「名字 → 实体 id」确认映射 */
    save(
      platform: string,
      kind: EncyclopediaKind,
      name: string,
      entityId: string,
      entityName: string,
    ): void {
      db.prepare(
        `INSERT INTO encyclopedia_entity_mappings
          (platform, kind, name, entity_id, entity_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, kind, name) DO UPDATE SET
           entity_id = excluded.entity_id,
           entity_name = excluded.entity_name,
           created_at = excluded.created_at`,
      ).run(platform, kind, name, entityId, entityName, new Date().toISOString())
    },

    /** 删除单条映射（渲染层「换一个」后不落库，服务层按需调用） */
    remove(platform: string, kind: EncyclopediaKind, name: string): void {
      db.prepare('DELETE FROM encyclopedia_entity_mappings WHERE platform = ? AND kind = ? AND name = ?').run(
        platform,
        kind,
        name,
      )
    },
  }
}

export type EncyclopediaStore = ReturnType<typeof createEncyclopediaStore>
