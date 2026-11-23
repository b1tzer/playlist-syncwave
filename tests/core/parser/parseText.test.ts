import { describe, it, expect } from 'vitest'
import { parseText } from '@core/parser/parseText'

describe('parseText — FR-2.1 文本快速创建', () => {
  it('解析「歌名 - 歌手」（默认顺序）', () => {
    const result = parseText('晴天 - 周杰伦')
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0]).toMatchObject({
      title: '晴天',
      artist: '周杰伦',
      lineNumber: 1,
      raw: '晴天 - 周杰伦',
      confidence: 0.9,
    })
    expect(result.failedLines).toHaveLength(0)
  })

  it('解析「歌手 - 歌名」（artist-first 顺序）', () => {
    const result = parseText('周杰伦 - 晴天', { order: 'artist-first' })
    expect(result.songs[0]).toMatchObject({ title: '晴天', artist: '周杰伦' })
  })

  it('解析纯歌名列表，歌手缺省且置信度较低', () => {
    const result = parseText('晴天\n稻香\n夜曲')
    expect(result.songs.map((s) => s.title)).toEqual(['晴天', '稻香', '夜曲'])
    expect(result.songs[0].artist).toBeUndefined()
    expect(result.songs[0].confidence).toBeLessThan(0.9)
  })

  it('去噪：序号前缀、时间戳、表情与空白', () => {
    const text = [
      '1. [00:12.30] 晴天 - 周杰伦',
      '2、稻香 - 周杰伦',
      '（3）🌟 夜曲 - 周杰伦',
      '4) 说谎 - 林宥嘉',
    ].join('\n')
    const result = parseText(text)
    expect(result.songs.map((s) => s.title)).toEqual(['晴天', '稻香', '夜曲', '说谎'])
    expect(result.songs.map((s) => s.artist)).toEqual([
      '周杰伦',
      '周杰伦',
      '周杰伦',
      '林宥嘉',
    ])
  })

  it('忽略空行与纯符号行，并保留真实行号', () => {
    const text = ['', '---', '晴天 - 周杰伦', '   ', '***', '稻香 - 周杰伦'].join('\n')
    const result = parseText(text)
    expect(result.songs).toHaveLength(2)
    expect(result.songs[0].lineNumber).toBe(3)
    expect(result.songs[1].lineNumber).toBe(6)
  })

  it('支持 -- / —— / 制表符 / 竖线 分隔符', () => {
    const text = ['晴天 -- 周杰伦', '稻香——周杰伦', '夜曲\t周杰伦', '说谎 | 林宥嘉'].join('\n')
    const result = parseText(text)
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', '周杰伦'],
      ['夜曲', '周杰伦'],
      ['说谎', '林宥嘉'],
    ])
  })

  it('保留括号内容（Live/Remix）与繁体字', () => {
    const result = parseText('晴天 (Live) - 周杰倫')
    expect(result.songs[0].title).toBe('晴天 (Live)')
    expect(result.songs[0].artist).toBe('周杰倫')
  })

  it('记录格式异常行到 failedLines，且不污染 songs', () => {
    const result = parseText('晴天 -\n- 周杰伦\n晴天 - 周杰伦')
    expect(result.songs).toHaveLength(1)
    expect(result.failedLines).toHaveLength(2)
    expect(result.failedLines[0]).toMatchObject({ lineNumber: 1, reason: 'missing-artist' })
    expect(result.failedLines[1]).toMatchObject({ lineNumber: 2, reason: 'missing-title' })
  })

  it('空输入返回空结果', () => {
    expect(parseText('')).toEqual({ songs: [], failedLines: [] })
    expect(parseText('   \n\n---\n')).toEqual({ songs: [], failedLines: [] })
  })

  it('保留重复行（不去重）', () => {
    const result = parseText('晴天 - 周杰伦\n晴天 - 周杰伦')
    expect(result.songs).toHaveLength(2)
  })

  it('混排文本：非歌曲文本按纯歌名解析，由用户预览阶段修正', () => {
    const result = parseText('分享歌单：我的收藏\n晴天 - 周杰伦')
    expect(result.songs).toHaveLength(2)
    expect(result.songs[0].artist).toBeUndefined()
    expect(result.songs[1].artist).toBe('周杰伦')
  })
})
