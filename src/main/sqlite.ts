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
}
