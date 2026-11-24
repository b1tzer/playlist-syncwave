import { describe, it, expect } from 'vitest'
import { findBestMatch, normalize } from '@core/matcher/matchSong'
import type { CandidateSong, MatchQuery } from '@core/models/match'

const jay = (id: string, title: string, artist = '周杰伦', durationMs?: number): CandidateSong => ({
  id,
  title,
  artist,
  durationMs,
})

const q = (title: string, artist?: string): MatchQuery => ({ title, artist })

describe('normalize — 文本归一化', () => {
  it('转小写、去空白与多余空格', () => {
    expect(normalize('  Hello   World ')).toBe('helloworld')
  })

  it('繁体转简体', () => {
    expect(normalize('周杰倫 - 晴天')).toBe('周杰伦-晴天')
  })

  it('去除括号内容（Live/Remix 变体）', () => {
    expect(normalize('晴天 (Live)')).toBe('晴天')
  })

  it('全角符号转半角', () => {
    expect(normalize('ＡＢＣ，１２３')).toBe('abc,123')
  })
})

describe('findBestMatch — 匹配评分（FR-3）', () => {
  it('标题与歌手精确匹配 → 高分且 matched', () => {
    const r = findBestMatch(q('晴天', '周杰伦'), [jay('1', '晴天')])
    expect(r).not.toBeNull()
    expect(r!.matched).toBe(true)
    expect(r!.score).toBeGreaterThanOrEqual(0.95)
  })

  it('仅凭歌名匹配（无歌手信息）→ 仍可匹配，分数略低', () => {
    const r = findBestMatch(q('晴天'), [jay('1', '晴天')])
    expect(r).not.toBeNull()
    expect(r!.matched).toBe(true)
    expect(r!.score).toBeLessThan(0.95)
    expect(r!.score).toBeGreaterThanOrEqual(0.8)
  })

  it('歌手不匹配 → 分数显著下降', () => {
    const r = findBestMatch(q('晴天', '周杰伦'), [jay('1', '晴天', '陈奕迅')])
    expect(r).not.toBeNull()
    expect(r!.score).toBeLessThan(0.9)
  })

  it('标题变体（Live/括号）：query 无标记选原版，query 带标记选对应版本', () => {
    const candidates = [jay('1', '晴天'), jay('2', '晴天 (Live)')]
    const exact = findBestMatch(q('晴天'), candidates)
    const variant = findBestMatch(q('晴天 (Live)'), candidates)
    expect(exact!.candidate.id).toBe('1')
    expect(variant!.candidate.id).toBe('2')
  })

  it('从多个候选中返回最高分', () => {
    const r = findBestMatch(q('晴天', '周杰伦'), [
      jay('1', '晴天', '陈奕迅'),
      jay('2', '晴天', '周杰伦'),
      jay('3', '稻香', '周杰伦'),
    ])
    expect(r!.candidate.id).toBe('2')
  })

  it('候选为空 → 返回 null', () => {
    expect(findBestMatch(q('晴天'), [])).toBeNull()
  })

  it('得分低于阈值 → matched 为 false', () => {
    const r = findBestMatch(q('完全不存在的歌', '某人'), [jay('1', '晴天')], { threshold: 0.5 })
    expect(r).not.toBeNull()
    expect(r!.matched).toBe(false)
  })

  it('时长相近可小幅加分', () => {
    const a = findBestMatch(q('晴天', '周杰伦'), [jay('1', '晴天', '周杰伦', 269_000)])
    const b = findBestMatch(q('晴天', '周杰伦'), [jay('1', '晴天', '周杰伦', 269_500)])
    expect(b!.score).toBeGreaterThanOrEqual(a!.score)
  })

  it('reasons 说明命中的因子', () => {
    const r = findBestMatch(q('晴天', '周杰伦'), [jay('1', '晴天')])
    expect(r!.reasons.length).toBeGreaterThan(0)
    expect(r!.reasons.some((x) => x.includes('title'))).toBe(true)
  })
})

describe('findBestMatch — feat/多歌手归一化（T8.1）', () => {
  it('歌手含 feat. 变体：主歌手精确 → 歌手精确加分', () => {
    const r = findBestMatch(q('爱一点', '莫艳琳'), [
      { id: '1', title: '爱一点', artist: '莫艳琳 feat. 陈洁仪' },
    ])
    expect(r!.score).toBeGreaterThanOrEqual(0.95)
    expect(r!.reasons).toContain('artist-exact')
  })

  it('多人名顿号连接：query 命中任一人名 → 歌手精确加分', () => {
    const r = findBestMatch(q('屋顶', '温岚'), [
      { id: '1', title: '屋顶', artist: '周杰伦、温岚' },
    ])
    expect(r!.score).toBeGreaterThanOrEqual(0.95)
    expect(r!.reasons).toContain('artist-exact')
  })

  it('歌手串人名无交集 → 不加歌手分', () => {
    const r = findBestMatch(q('爱一点', '王力宏'), [
      { id: '1', title: '爱一点', artist: '莫艳琳 feat. 陈洁仪' },
    ])
    expect(r!.score).toBeLessThan(0.9)
  })
})

describe('findBestMatch — 版本标记消歧（T8.2）', () => {
  it('query 带版本标记：同标记候选优先', () => {
    const r = findBestMatch(q('晴天 (Live)'), [
      jay('1', '晴天 (Remix)'),
      jay('2', '晴天 (Live)'),
    ])
    expect(r!.candidate.id).toBe('2')
    expect(r!.reasons).toContain('version-match')
  })

  it('query 带版本标记：异标记候选降权，无标记候选胜出', () => {
    const r = findBestMatch(q('晴天 (Live)'), [
      jay('1', '晴天 (Remix)'),
      jay('2', '晴天'),
    ])
    expect(r!.candidate.id).toBe('2')
  })

  it('版本词全角/大小写归一化仍可识别', () => {
    const r = findBestMatch(q('晴天（ＬＩＶＥ）'), [jay('1', '晴天 (Live)')])
    expect(r!.reasons).toContain('version-match')
  })
})

describe('findBestMatch — 专辑因子（T8.3）', () => {
  it('专辑精确匹配 → album-exact 加分', () => {
    const r = findBestMatch(
      { title: '晴天', artist: '周杰伦', album: '叶惠美' },
      [
        { id: '1', title: '晴天', artist: '周杰伦', album: '范特西' },
        { id: '2', title: '晴天', artist: '周杰伦', album: '叶惠美' },
      ],
    )
    expect(r!.candidate.id).toBe('2')
    expect(r!.reasons).toContain('album-exact')
  })

  it('专辑部分包含 → album-partial 加分', () => {
    const r = findBestMatch(
      { title: '晴天', artist: '周杰伦', album: 'Greatest Hits' },
      [{ id: '1', title: '晴天', artist: '周杰伦', album: 'Greatest Hits 2010' }],
    )
    expect(r!.reasons).toContain('album-partial')
  })

  it('query 无专辑：行为不变', () => {
    const r = findBestMatch(q('晴天', '周杰伦'), [
      { id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美' },
    ])
    expect(r!.score).toBeCloseTo(0.95)
    expect(r!.reasons).not.toContain('album-exact')
  })
})
