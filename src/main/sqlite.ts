/**
 * better-sqlite3 的最小抽象：各业务 Store 与 appDatabase 共用，
 * 便于测试注入 fake 数据库。
 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  pragma?(sql: string): unknown
  close?(): unknown
  /** 事务包装（可选：注入的 fake 数据库可不实现） */
  transaction?(fn: () => void): () => void
}

/** 事务执行：数据库不支持事务（测试 fake）时退化为直接执行 */
export function withTransaction(db: SqliteDb, fn: () => void): void {
  if (db.transaction) {
    db.transaction(fn)()
  } else {
    fn()
  }
}
