/**
 * 简单进程内 LRU：插入序即最近使用序（命中时移到末尾），
 * 容量满载时淘汰最久未使用的键。主进程各服务共用。
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>()

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) {
      // 命中视为最近使用：先删后插移到末尾
      this.map.delete(key)
      this.map.set(key, value)
    }
    return value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key)
  }

  /** 遍历当前键（快照），供按前缀失效等场景使用 */
  keys(): string[] {
    return [...this.map.keys()]
  }
}
