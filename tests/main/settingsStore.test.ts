import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSettingsStore } from '../../src/main/settingsStore'

describe('settingsStore — 应用设置持久化', () => {
  let store: ReturnType<typeof createSettingsStore>

  beforeEach(() => {
    store = createSettingsStore(new Database(':memory:'))
  })

  it('无记录时返回默认值', () => {
    expect(store.get('autoLaunch', false)).toBe(false)
    expect(store.get('batchSize', 500)).toBe(500)
  })

  it('set 后可读回，类型保持', () => {
    store.set('autoLaunch', true)
    store.set('autoUpdateEnabled', true)
    store.set('batchSize', 120)
    store.set('theme', 'dark')
    expect(store.get('autoLaunch', false)).toBe(true)
    expect(store.get('autoUpdateEnabled', false)).toBe(true)
    expect(store.get('batchSize', 0)).toBe(120)
    expect(store.get('theme', 'light')).toBe('dark')
  })

  it('重复 set 为更新', () => {
    store.set('autoLaunch', true)
    store.set('autoLaunch', false)
    expect(store.all()).toEqual({ autoLaunch: false })
  })

  it('remove 删除单项', () => {
    store.set('a', 1)
    store.set('b', 2)
    store.remove('a')
    expect(store.get('a', 0)).toBe(0)
    expect(store.get('b', 0)).toBe(2)
  })

  it('all 返回全部键值', () => {
    store.set('a', true)
    store.set('b', 'text')
    expect(store.all()).toEqual({ a: true, b: 'text' })
  })
})
