import { describe, it, expect } from 'vitest'
import { classifyLine, detectFormat } from '@core/parser/detect'

describe('detectFormat — 输入格式自动探测', () => {
  it('JSON 数组 → json', () => {
    expect(detectFormat('[{"title":"晴天","artist":"周杰伦"}]')).toBe('json')
  })

  it('m3u → m3u', () => {
    expect(detectFormat('#EXTM3U\n#EXTINF:249,周杰伦 - 晴天')).toBe('m3u')
    expect(detectFormat('#EXTINF:249,周杰伦 - 晴天\n晴天.mp3')).toBe('m3u')
  })

  it('LRC 歌词：时间戳行占比高 → lrc', () => {
    const text = ['[00:00.00]晴天 - 周杰伦', '[00:12.30]作词：方文山', '[00:30.00]作曲：周杰伦'].join('\n')
    expect(detectFormat(text)).toBe('lrc')
  })

  it('CSV/表格：行列数一致 → csv', () => {
    expect(detectFormat('歌名\t歌手\n晴天\t周杰伦\n稻香\t周杰伦')).toBe('csv')
    expect(detectFormat('歌名,歌手\n晴天,周杰伦\n稻香,周杰伦')).toBe('csv')
  })

  it('平台分享文本 → share', () => {
    expect(detectFormat('分享xxx的歌单《我的收藏》：晴天 - 周杰伦')).toBe('share')
    expect(
      detectFormat('晴天 - 周杰伦\n链接: https://music.163.com/song?id=186016'),
    ).toBe('share')
  })

  it('普通行式文本 → lines', () => {
    expect(detectFormat('晴天 - 周杰伦\n稻香 - 周杰伦')).toBe('lines')
    expect(detectFormat('')).toBe('lines')
  })
})

describe('classifyLine — 行分类', () => {
  it('空行与纯符号行 → noise', () => {
    expect(classifyLine('').category).toBe('noise')
    expect(classifyLine('   ').category).toBe('noise')
    expect(classifyLine('---').category).toBe('noise')
    expect(classifyLine('***').category).toBe('noise')
  })

  it('歌词元信息行（作词/作曲/专辑）→ meta', () => {
    expect(classifyLine('作词：方文山').category).toBe('meta')
    expect(classifyLine('作曲: 周杰伦').category).toBe('meta')
    expect(classifyLine('专辑：叶惠美').category).toBe('meta')
  })

  it('分享模板行 → template', () => {
    expect(classifyLine('分享xxx的歌单《我的收藏》').category).toBe('template')
    expect(classifyLine('来自网易云音乐').category).toBe('template')
    expect(classifyLine('复制这条信息，打开App').category).toBe('template')
  })

  it('分享模板行含《歌名》时可提取歌名', () => {
    const line = classifyLine('分享xxx的歌曲《晴天》')
    expect(line.category).toBe('template')
    expect(line.quotedTitle).toBe('晴天')
  })

  it('聊天行：剥说话人前缀后继续解析', () => {
    const line = classifyLine('张三: 晴天 - 周杰伦')
    expect(line.category).toBe('chat')
    expect(line.cleaned).toBe('晴天 - 周杰伦')
  })

  it('聊天行：【昵称】前缀', () => {
    const line = classifyLine('【李四】稻香——周杰伦')
    expect(line.category).toBe('chat')
    expect(line.cleaned).toBe('稻香——周杰伦')
  })

  it('URL 行 → link', () => {
    expect(classifyLine('https://music.163.com/song?id=186016').category).toBe('link')
  })

  it('普通歌曲行 → song', () => {
    const line = classifyLine('晴天 - 周杰伦')
    expect(line.category).toBe('song')
    expect(line.cleaned).toBe('晴天 - 周杰伦')
  })

  it('数字时间戳冒号不误剥（04:44）', () => {
    const line = classifyLine('04:44 晴天 - 周杰伦')
    expect(line.category).toBe('song')
    expect(line.cleaned).toBe('04:44 晴天 - 周杰伦')
  })

  it('英文歌名冒号不误剥（Time: The Revelator）', () => {
    const line = classifyLine('Time: The Revelator - Gillian Welch')
    expect(line.category).toBe('song')
    expect(line.cleaned).toBe('Time: The Revelator - Gillian Welch')
  })

  it('英文昵称 + 中文内容仍剥（John: 晴天）', () => {
    const line = classifyLine('John: 晴天 - 周杰伦')
    expect(line.category).toBe('chat')
    expect(line.cleaned).toBe('晴天 - 周杰伦')
  })

  it('中文昵称冒号仍剥', () => {
    const line = classifyLine('张三: 晴天 - 周杰伦')
    expect(line.category).toBe('chat')
    expect(line.cleaned).toBe('晴天 - 周杰伦')
  })

  it('英文冒号 + 英文内容不剥（NickName123: hello world）', () => {
    const line = classifyLine('NickName123: hello world')
    expect(line.category).toBe('song')
    expect(line.cleaned).toBe('NickName123: hello world')
  })
})
