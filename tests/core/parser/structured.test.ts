import { describe, it, expect } from 'vitest'
import { parseText } from '@core/parser/parseText'

describe('parseText — 结构格式全自动解析（T6.3）', () => {
  it('JSON 数组（title/artist 键）', () => {
    const result = parseText('[{"title":"晴天","artist":"周杰伦"},{"title":"稻香","artist":"周杰伦"}]')
    expect(result.format).toBe('json')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', '周杰伦'],
    ])
  })

  it('JSON 键别名（name/singer）与嵌套对象', () => {
    const result = parseText('{"songs":[{"name":"晴天","singer":"周杰伦"},{"name":"稻香"}]}')
    expect(result.format).toBe('json')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', undefined],
    ])
  })

  it('m3u：#EXTINF 行提取，字段顺序自动判定', () => {
    const result = parseText('#EXTM3U\n#EXTINF:249,周杰伦 - 晴天\n#EXTINF:243,林宥嘉 - 说谎\nsong.mp3')
    expect(result.format).toBe('m3u')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['说谎', '林宥嘉'],
    ])
  })

  it('LRC 歌词：剥时间戳、过滤元信息行', () => {
    const result = parseText(
      '[00:00.00]晴天 - 周杰伦\n[00:12.30]作词：方文山\n[00:30.00]稻香 - 周杰伦',
    )
    expect(result.format).toBe('lrc')
    expect(result.songs.map((s) => s.title)).toEqual(['晴天', '稻香'])
  })

  it('CSV（tab 分隔，含表头列映射）', () => {
    const result = parseText('歌名\t歌手\n晴天\t周杰伦\n稻香\t周杰伦')
    expect(result.format).toBe('csv')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', '周杰伦'],
    ])
  })

  it('CSV（逗号分隔，英文表头）', () => {
    const result = parseText('title,artist\n晴天,周杰伦\n稻香,周杰伦')
    expect(result.format).toBe('csv')
    expect(result.songs).toHaveLength(2)
    expect(result.songs[0]).toMatchObject({ title: '晴天', artist: '周杰伦' })
  })

  it('CSV 无表头：按 [歌名, 歌手] 顺序解析', () => {
    const result = parseText('晴天,周杰伦\n稻香,周杰伦')
    expect(result.format).toBe('csv')
    expect(result.songs.map((s) => [s.title, s.artist])).toEqual([
      ['晴天', '周杰伦'],
      ['稻香', '周杰伦'],
    ])
  })

  it('CSV 歌手列缺失 → 仅歌名，置信度较低', () => {
    const result = parseText('歌名,歌手\n晴天,\n稻香,')
    expect(result.format).toBe('csv')
    expect(result.songs.map((s) => s.title)).toEqual(['晴天', '稻香'])
    expect(result.songs[0].artist).toBeUndefined()
    expect(result.songs[0].confidence).toBeLessThan(0.9)
  })
})
