import { describe, it, expect } from 'vitest'
import { normalizeReleaseDate } from '../../src/platforms/releaseDate'

describe('normalizeReleaseDate — 上游发行时间归一化', () => {
  it('毫秒时间戳（网易云 publishTime）转 yyyy-MM-dd', () => {
    expect(normalizeReleaseDate('1069167600000')).toBe('2003-11-18')
  })

  it('秒时间戳同样支持', () => {
    expect(normalizeReleaseDate('1069167600')).toBe('2003-11-18')
  })

  it('yyyy-MM-dd / yyyy.MM.dd 原样归一', () => {
    expect(normalizeReleaseDate('2003-07-16')).toBe('2003-07-16')
    expect(normalizeReleaseDate('2003.07.16')).toBe('2003-07-16')
  })

  it('中文日期分隔符', () => {
    expect(normalizeReleaseDate('2003年7月16日')).toBe('2003-07-16')
  })

  it('非法输入返回 undefined', () => {
    expect(normalizeReleaseDate(undefined)).toBeUndefined()
    expect(normalizeReleaseDate('')).toBeUndefined()
    expect(normalizeReleaseDate('去年夏天')).toBeUndefined()
    expect(normalizeReleaseDate('99999')).toBeUndefined()
    expect(normalizeReleaseDate('2003-13-45')).toBeUndefined()
  })

  it('日历上不存在的日期（2 月 30 日）返回 undefined', () => {
    expect(normalizeReleaseDate('2003-02-30')).toBeUndefined()
  })

  it('时间戳按东八区取日期：UTC 前一天深夜发行仍归当天', () => {
    // 2024-01-01T20:00Z = 北京时间 2024-01-02 04:00
    expect(normalizeReleaseDate(String(Date.UTC(2024, 0, 1, 20, 0, 0)))).toBe('2024-01-02')
    expect(normalizeReleaseDate(String(Math.floor(Date.UTC(2024, 0, 1, 20, 0, 0) / 1000)))).toBe(
      '2024-01-02',
    )
  })

  it('10~12 位一律按秒、13 位按毫秒（位数判定与数值无关）', () => {
    // 同一时刻的秒/毫秒两种表示，归一结果一致
    const sec = String(Math.floor(Date.UTC(2003, 10, 18, 12, 20, 0) / 1000))
    expect(normalizeReleaseDate(sec)).toBe('2003-11-18')
    expect(normalizeReleaseDate(`${sec}000`)).toBe('2003-11-18')
  })
})
