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

  it('歌手名含 feat. 变体：主歌手精确即视为同一歌手 → exact 自动选', () => {
    const r = classifyCandidates(
      { title: '爱一点', artist: '莫艳琳' },
      [song('1', '爱一点', '莫艳琳 feat. 陈洁仪')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('1')
  })

  it('多人名顿号连接：query 命中任一歌手 → exact 自动选', () => {
    const r = classifyCandidates(
      { title: '屋顶', artist: '周杰伦' },
      [song('1', '屋顶', '周杰伦、温岚')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('1')
  })

  it('歌手串人名无交集 → 仍为 title-only 手动选择', () => {
    const r = classifyCandidates(
      { title: '爱一点', artist: '王力宏' },
      [song('1', '爱一点', '莫艳琳 feat. 陈洁仪')],
    )
    expect(r.kind).toBe('title-only')
  })

  it('query 带版本标记（Live）→ 优先选同版本候选', () => {
    const r = classifyCandidates(
      { title: '晴天 (Live)', artist: '周杰伦' },
      [song('1', '晴天', '周杰伦'), song('2', '晴天 (Live)', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('2')
  })

  it('query 无版本标记 → 优先选原版（无版本标记候选）', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '晴天 (Live)', '周杰伦'), song('2', '晴天', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('2')
  })

  it('候选全为版本变体时回退（不因版本过滤而丢失匹配）', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '晴天 (Live)', '周杰伦'), song('2', '晴天 (Remix)', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(['1', '2']).toContain(r.songId)
  })

  it('query 版本标记与候选均不一致 → 回退全部候选', () => {
    const r = classifyCandidates(
      { title: '晴天 (Remix)', artist: '周杰伦' },
      [song('1', '晴天 (Live)', '周杰伦'), song('2', '晴天', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(['1', '2']).toContain(r.songId)
  })

  it('搜索反向验证：query 顺序颠倒时，平台结果证明后自动采纳', () => {
    const r = classifyCandidates(
      { title: '周杰伦', artist: '晴天' },
      [song('1', '晴天', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('1')
  })

  it('反向验证与正向精确并存时，正向优先', () => {
    const r = classifyCandidates(
      { title: '晴天', artist: '周杰伦' },
      [song('1', '周杰伦', '晴天'), song('2', '晴天', '周杰伦')],
    )
    expect(r.kind).toBe('exact')
    if (r.kind === 'exact') expect(r.songId).toBe('2')
  })
})
