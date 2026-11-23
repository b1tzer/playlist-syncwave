import { describe, it, expect } from 'vitest'
import { parseText } from '@core/parser/parseText'

describe('parseText — FR-2.1 文本快速创建', () => {
  it('解析「歌名 - 歌手」（自动判定顺序）', () => {
    const result = parseText('晴天 - 周杰伦')
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0]).toMatchObject({
      title: '晴天',
      artist: '周杰伦',
      lineNumber: 1,
      raw: '晴天 - 周杰伦',
    })
    expect(result.songs[0].confidence).toBeGreaterThanOrEqual(0.8)
    expect(result.songs[0].orderConfidence).toBeGreaterThanOrEqual(0.8)
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
    expect(parseText('')).toEqual({ format: 'lines', songs: [], failedLines: [], ignoredLines: [] })
    expect(parseText('   \n\n---\n')).toEqual({
      format: 'lines',
      songs: [],
      failedLines: [],
      ignoredLines: [],
    })
  })

  it('保留重复行（不去重）', () => {
    const result = parseText('晴天 - 周杰伦\n晴天 - 周杰伦')
    expect(result.songs).toHaveLength(2)
  })

  it('混排文本：分享模板行进 ignoredLines，歌曲行正常解析', () => {
    const result = parseText('分享歌单：我的收藏\n晴天 - 周杰伦')
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0]).toMatchObject({ title: '晴天', artist: '周杰伦' })
    expect(result.ignoredLines).toHaveLength(1)
    expect(result.ignoredLines[0]).toMatchObject({ lineNumber: 1, category: 'template' })
  })

  it('全自动：混排两种字段顺序，无需手动指定', () => {
    const result = parseText('晴天 - 周杰伦\n周杰伦 - 稻香\n林宥嘉 - 说谎')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', '周杰伦'],
      ['说谎', '林宥嘉'],
    ])
  })

  it('全自动：整段投票纠正无信号歧义行', () => {
    const result = parseText('周杰伦 - 晴天\n周杰伦 - 稻香\n张三 - 预谋邂逅')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', '周杰伦'],
      ['预谋邂逅', '张三'],
    ])
  })

  it('聊天行：剥说话人前缀后解析', () => {
    const result = parseText('张三: 晴天 - 周杰伦\n【李四】稻香——周杰伦')
    expect(result.songs.map((s) => s.title)).toEqual(['晴天', '稻香'])
  })

  it('书名号锚定：《歌名》歌手 与 歌手《歌名》', () => {
    const result = parseText('《乌梅子酱》李荣浩\n李荣浩《年少有为》')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['乌梅子酱', '李荣浩'],
      ['年少有为', '李荣浩'],
    ])
  })

  it('分享模板行含《歌名》时提取为歌曲', () => {
    const result = parseText('分享xxx的歌曲《晴天》')
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0].title).toBe('晴天')
  })

  it('歧义行（无投票裁决）保留双候选供预览切换', () => {
    const result = parseText('张三 - 预谋邂逅')
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0].candidates).toHaveLength(2)
    expect(result.songs[0].orderConfidence).toBeLessThanOrEqual(0.5)
  })

  it('歌词元信息行进 ignoredLines', () => {
    const result = parseText('作词：方文山\n作曲：周杰伦\n晴天 - 周杰伦')
    expect(result.songs).toHaveLength(1)
    expect(result.ignoredLines).toHaveLength(2)
    expect(result.ignoredLines.map((l) => l.category)).toEqual(['meta', 'meta'])
  })

  it('分享文本探测：format 标记 share', () => {
    const result = parseText('晴天 - 周杰伦\n链接: https://music.163.com/song?id=186016')
    expect(result.format).toBe('share')
    expect(result.songs.map((s) => s.title)).toEqual(['晴天'])
  })
})
