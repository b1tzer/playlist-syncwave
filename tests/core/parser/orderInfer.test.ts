import { describe, it, expect } from 'vitest'
import { inferPair, majorityOrder, splitQuotedTitle } from '@core/parser/orderInfer'
import type { FieldOrder } from '@core/models/parse'

describe('splitQuotedTitle — 书名号锚定', () => {
  it('《歌名》歌手 → 提取歌名与歌手', () => {
    expect(splitQuotedTitle('《乌梅子酱》李荣浩')).toEqual({
      title: '乌梅子酱',
      artist: '李荣浩',
    })
  })

  it('歌手《歌名》 → 提取歌名与歌手', () => {
    expect(splitQuotedTitle('李荣浩《乌梅子酱》')).toEqual({
      title: '乌梅子酱',
      artist: '李荣浩',
    })
  })

  it('仅《歌名》→ 只有歌名', () => {
    expect(splitQuotedTitle('《晴天》')).toEqual({ title: '晴天' })
  })

  it('无书名号 → null', () => {
    expect(splitQuotedTitle('晴天 - 周杰伦')).toBeNull()
  })
})

describe('inferPair — 字段顺序自动判定', () => {
  it('版本词在歌名侧 → title-first', () => {
    expect(inferPair('晴天 (Live)', '周杰伦').order).toBe('title-first')
  })

  it('多人名连接词在歌手侧 → artist-first', () => {
    expect(inferPair('周杰伦、蔡依林', '布拉格广场').order).toBe('artist-first')
  })

  it('feat. 结构在歌手侧 → artist-first', () => {
    expect(inferPair('Ed Sheeran feat. Beyoncé', 'Perfect').order).toBe('artist-first')
  })

  it('无信号且双方都可能 → ambiguous', () => {
    const r = inferPair('张三', '预谋邂逅')
    expect(r.order).toBe('ambiguous')
    expect(r.confidence).toBeLessThan(0.6)
  })

  it('两侧信号相抵 → ambiguous，不误判', () => {
    const r = inferPair('周杰伦', '蔡依林')
    expect(r.order).toBe('ambiguous')
  })

  it('无任何信号 → ambiguous（顺序交由搜索验证）', () => {
    expect(inferPair('晴天', '周杰伦').order).toBe('ambiguous')
    expect(inferPair('周杰伦', '晴天').order).toBe('ambiguous')
  })

  it('词根误匹配不作版本词信号：Forever. / Deliver / Recover', () => {
    expect(inferPair('Forever.', 'Hidden').order).toBe('ambiguous')
    expect(inferPair('Deliver', 'Hidden').order).toBe('ambiguous')
    expect(inferPair('Recover', 'Hidden').order).toBe('ambiguous')
  })

  it('真实版本词仍作歌名侧信号', () => {
    expect(inferPair('晴天 (Live)', '张三').order).toBe('title-first')
    expect(inferPair('晴天（Remix）', '张三').order).toBe('title-first')
  })
})

describe('majorityOrder — 整段一致性投票', () => {
  const rows: Array<FieldOrder | 'ambiguous'> = [
    'artist-first',
    'artist-first',
    'artist-first',
    'ambiguous',
  ]

  it('多数定序（≥60%）→ 返回该顺序', () => {
    expect(majorityOrder(rows)).toBe('artist-first')
    expect(majorityOrder(['title-first', 'title-first', 'artist-first', 'ambiguous'])).toBe(
      'title-first',
    )
  })

  it('样本不足或未达阈值 → undefined', () => {
    expect(majorityOrder(['title-first', 'ambiguous'])).toBeUndefined()
    expect(majorityOrder(['title-first', 'artist-first'])).toBeUndefined()
  })
})
