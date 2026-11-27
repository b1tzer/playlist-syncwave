import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createEncyclopediaStore } from '../../src/main/encyclopediaStore'

describe('encyclopediaStore — 百科纠偏映射', () => {
  let store: ReturnType<typeof createEncyclopediaStore>

  beforeEach(() => {
    store = createEncyclopediaStore(new Database(':memory:'))
  })

  it('保存后可查回，重复保存为覆盖更新', () => {
    store.save('netease', 'singer', '周杰伦', '6452', '周杰伦')
    let found = store.find('netease', 'singer', '周杰伦')
    expect(found?.entityId).toBe('6452')

    store.save('netease', 'singer', '周杰伦', '6453', '周杰伦 (Live)')
    found = store.find('netease', 'singer', '周杰伦')
    expect(found?.entityId).toBe('6453')
    expect(found?.entityName).toBe('周杰伦 (Live)')
  })

  it('平台/类型/名字三维唯一，同名不同平台互不干扰', () => {
    store.save('netease', 'singer', '陈奕迅', 'n1', '陈奕迅')
    store.save('qqmusic', 'singer', '陈奕迅', 'q1', '陈奕迅')
    store.save('netease', 'album', '陈奕迅', 'a1', '陈奕迅专辑')
    expect(store.find('netease', 'singer', '陈奕迅')?.entityId).toBe('n1')
    expect(store.find('qqmusic', 'singer', '陈奕迅')?.entityId).toBe('q1')
    expect(store.find('netease', 'album', '陈奕迅')?.entityId).toBe('a1')
  })

  it('未保存过的名字返回 null', () => {
    expect(store.find('netease', 'singer', '不存在')).toBeNull()
  })

  it('remove 删除单条映射', () => {
    store.save('netease', 'singer', '周杰伦', '6452', '周杰伦')
    store.remove('netease', 'singer', '周杰伦')
    expect(store.find('netease', 'singer', '周杰伦')).toBeNull()
  })
})
