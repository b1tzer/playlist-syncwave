import { describe, it, expect } from 'vitest'
import { toM3u } from '../../../src/core/export/toM3u'
import { toCsv } from '../../../src/core/export/toCsv'

describe('导出格式生成', () => {
  const songs = [
    { title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 },
    { title: 'A,B', artist: '', album: '含"引号"', durationMs: undefined },
  ]

  it('m3u：含表头与每首 EXTINF/名称两行', () => {
    const out = toM3u(songs)
    expect(out).toBe(
      [
        '#EXTM3U',
        '#EXTINF:269,周杰伦 - 晴天',
        '周杰伦 - 晴天',
        '#EXTINF:-1,A,B',
        'A,B',
        '',
      ].join('\n'),
    )
  })

  it('m3u：无歌手时名称行只有歌名', () => {
    expect(toM3u([{ title: '晴天' }])).toBe(['#EXTM3U', '#EXTINF:-1,晴天', '晴天', ''].join('\n'))
  })

  it('csv：表头与转义（逗号/引号字段）', () => {
    const out = toCsv(songs)
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('title,artist,album,duration_ms')
    expect(lines[1]).toBe('晴天,周杰伦,叶惠美,269000')
    expect(lines[2]).toBe('"A,B",,"含""引号""",')
  })

  it('csv：空歌单只有表头', () => {
    expect(toCsv([])).toBe('title,artist,album,duration_ms\n')
  })
})
