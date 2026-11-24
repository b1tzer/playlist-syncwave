import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createMappingStore } from '../../src/main/mappingStore'
import type { PlatformSong } from '@core/models/platform'

const song = (id: string, title: string, artist: string): PlatformSong => ({
  id,
  title,
  artist,
})

describe('mappingStore — 跨平台歌曲映射缓存', () => {
  let store: ReturnType<typeof createMappingStore>

  beforeEach(() => {
    store = createMappingStore(new Database(':memory:'))
  })

  it('保存自动匹配后可查回，按分数排序', () => {
    store.saveAutoMatch('netease', { title: '晴天', artist: '周杰伦' }, song('1', '晴天', '周杰伦'), 0.8)
    store.saveAutoMatch('netease', { title: '晴天', artist: '周杰伦' }, song('2', '晴天', '周杰伦'), 0.95)
    const rows = store.findByQuery('netease', { title: '晴天', artist: '周杰伦' })
    expect(rows).toHaveLength(2)
    expect(rows[0].songId).toBe('2')
    expect(rows[0].score).toBe(0.95)
  })

  it('人工确认映射优先级最高', () => {
    store.saveAutoMatch('netease', { title: '晴天', artist: '周杰伦' }, song('1', '晴天', '周杰伦'), 0.9)
    store.saveConfirmed(
      'netease',
      { query: { title: '晴天', artist: '周杰伦' }, candidates: [song('2', '晴天 (Live)', '周杰伦')] },
      '2',
    )
    const rows = store.findByQuery('netease', { title: '晴天', artist: '周杰伦' })
    expect(rows[0].songId).toBe('2')
    expect(rows[0].confirmed).toBe(1)
  })

  it('同歌同平台同歌曲重复保存为更新而非插入', () => {
    store.saveAutoMatch('netease', { title: '晴天' }, song('1', '晴天', '周杰伦'), 0.7)
    store.saveAutoMatch('netease', { title: '晴天' }, song('1', '晴天 (Live)', '周杰伦'), 0.6)
    const rows = store.findByQuery('netease', { title: '晴天' })
    expect(rows).toHaveLength(1)
    expect(rows[0].songTitle).toBe('晴天 (Live)')
  })

  it('不同平台互不干扰', () => {
    store.saveAutoMatch('netease', { title: '晴天' }, song('1', '晴天', '周杰伦'), 0.9)
    store.saveAutoMatch('qqmusic', { title: '晴天' }, song('9', '晴天', '周杰伦'), 0.9)
    expect(store.findByQuery('netease', { title: '晴天' })).toHaveLength(1)
    expect(store.findByQuery('qqmusic', { title: '晴天' })).toHaveLength(1)
  })

  it('countByPlatform 统计各平台缓存量与确认数', () => {
    store.saveAutoMatch('netease', { title: 'A' }, song('1', 'A', 'X'), 0.8)
    store.saveAutoMatch('netease', { title: 'B' }, song('2', 'B', 'X'), 0.8)
    store.saveConfirmed('qqmusic', { query: { title: 'C' }, candidates: [song('3', 'C', 'X')] }, '3')
    const stats = store.countByPlatform()
    expect(stats).toEqual([
      { platform: 'netease', count: 2, confirmed: 0 },
      { platform: 'qqmusic', count: 1, confirmed: 1 },
    ])
  })

  it('clearPlatform 清空单平台缓存', () => {
    store.saveAutoMatch('netease', { title: 'A' }, song('1', 'A', 'X'), 0.8)
    store.saveAutoMatch('qqmusic', { title: 'A' }, song('2', 'A', 'X'), 0.8)
    store.clearPlatform('netease')
    expect(store.findByQuery('netease', { title: 'A' })).toHaveLength(0)
    expect(store.findByQuery('qqmusic', { title: 'A' })).toHaveLength(1)
  })

  it('空查询返回空数组', () => {
    expect(store.findByQuery('netease', { title: '无' })).toEqual([])
    expect(store.countByPlatform()).toEqual([])
  })
})
