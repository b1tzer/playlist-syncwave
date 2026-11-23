import { describe, it, expect } from 'vitest'
import { classifyCandidates } from '@core/matcher/exactMatch'
import type { PlatformSong } from '@core/models/platform'

const song = (id: string, title: string, artist: string, durationMs?: number): PlatformSong => ({
  id,
  title,
  artist,
  durationMs,
})

describe('classifyCandidates — 金标准判定', () => {
  it('标题+歌手精确相等 → exact，自动选择', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '晴天', '周杰伦'), song('2', '别的歌', '别人')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('1')
  })

  it('标题精确、歌手不同 → title-only，产出候选供手动选择', () => {
    const r = classifyCandidates(
      { title: '勇气', artist: '梁静茹' },
      [song('1', '勇气', '棉子'), song('2', '勇气', '金志文')],
    )
    expect(r.kind).toBe('title-only')
    if (r.kind === 'title-only') {
      expect(r.candidates.map((c) => c.id)).toEqual(['1', '2'])
    }
  })

  it('query 有歌手：候选含该歌手的精确匹配时，忽略其他同名候选', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '晴天', '翻唱者'), song('2', '晴天', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('2')
  })

  it('query 无歌手：唯一标题精确 → exact 自动', () => {
    const r = classifyCandidates({ title: '稻香' }, [song('1', '稻香', '周杰伦')])
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('1')
  })

  it('query 无歌手：多个标题精确但歌手不同 → title-only 手动', () => {
    const r = classifyCandidates(
      { title: '勇气' },
      [song('1', '勇气', '棉子'), song('2', '勇气', '金志文')],
    )
    expect(r.kind).toBe('title-only')
    if (r.kind === 'title-only') expect(r.candidates).toHaveLength(2)
  })

  it('标题归一化相等（繁简/括号/空白）视为精确：同歌同唱 → exact', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '晴天 (Live)', '周杰倫')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('1')
  })

  it('同歌同唱多个收录 → exact，按时长最接近者选择', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦', durationMs: 269_000 },
      [
        song('1', '晴天', '周杰伦', 210_000),
        song('2', '晴天', '周杰伦', 268_000),
      ],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('2')
  })

  it('无任何标题精确匹配 → variant，交给评分引擎', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '完全不搭边', '另一个人')],
    )
    expect(r.kind).toBe('variant')
  })

  it('空候选 → variant', () => {
    const r = classifyCandidates({ title: '晴天' }, [])
    expect(r.kind).toBe('variant')
  })

  it('标题相同但歌手名有括号变体（如 feat.）也视为同歌不同作者候选', () => {
    const r = classifyCandidates(
      { title: '爱一点', artist: '莫艳琳' },
      [song('1', '爱一点', '莫艳琳 feat. 陈洁仪')],
    )
    expect(r.kind).toBe('title-only')
  })
})
