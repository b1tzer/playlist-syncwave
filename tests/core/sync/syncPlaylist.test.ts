import { describe, it, expect, vi } from 'vitest'
import { syncPlaylist } from '@core/sync/syncPlaylist'
import { SearchError, type SyncOptions, type SyncTarget } from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'

const song = (id: string, title: string, artist: string): PlatformSong => ({
  id,
  title,
  artist,
})

function makeTarget(
  index: Record<string, PlatformSong[]>,
  options: { createError?: boolean; addError?: boolean } = {},
): SyncTarget {
  return {
    searchSongs: vi.fn(async (keyword: string) => index[keyword] ?? []),
    createPlaylist: vi.fn(async (name: string) => {
      if (options.createError) throw new Error('建单失败')
      return `pl-${name}`
    }),
    addSongs: vi.fn(async () => {
      if (options.addError) throw new Error('添加失败')
    }),
  }
}

/** 测试专用：关闭限速，避免拖慢用例 */
const run = (
  queries: MatchQuery[],
  name: string,
  target: SyncTarget,
  options: SyncOptions = {},
) => syncPlaylist(queries, name, target, { searchIntervalMs: 0, ...options })

describe('syncPlaylist — 单向同步引擎（T4）', () => {
  it('全部匹配成功：创建歌单并添加歌曲，报告正确', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '稻香', artist: '周杰伦' }],
      '我的歌单',
      target,
    )
    expect(report).toMatchObject({ playlistName: '我的歌单', total: 2, matched: 2, added: 2 })
    expect(report.playlistId).toBe('pl-我的歌单')
    expect(report.failed).toHaveLength(0)
    expect(target.createPlaylist).toHaveBeenCalledWith('我的歌单')
    expect(target.addSongs).toHaveBeenCalledWith('pl-我的歌单', ['1', '2'])
  })

  it('搜索无结果 → no-match 失败项', async () => {
    const target = makeTarget({ 晴天: [song('1', '晴天', '周杰伦')] })
    const report = await run([{ title: '不存在的歌', artist: '某人' }], 'x', target)
    expect(report.matched).toBe(0)
    expect(report.added).toBe(0)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('no-match')
  })

  it('搜索抛异常 → search-failed 失败项，不中断整体', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
    })
    target.searchSongs = vi.fn(async (keyword: string) => {
      if (keyword === '坏歌') throw new Error('网络错误')
      return [{ id: '1', title: '晴天', artist: '周杰伦' }]
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '坏歌' }],
      'x',
      target,
    )
    expect(report.added).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('search-failed')
  })

  it('低置信度候选（<threshold）→ no-match，不添加', async () => {
    const target = makeTarget({
      晴天: [song('1', '完全不搭边', '另一个人')],
    })
    const report = await run([{ title: '晴天', artist: '周杰伦' }], 'x', target)
    expect(report.added).toBe(0)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('no-match')
  })

  it('批量添加：按 batchSize 分批调用', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 5; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    const report = await run(
      [1, 2, 3, 4, 5].map((i) => ({ title: `歌${i}`, artist: '某人' })),
      'x',
      target,
      { batchSize: 2 },
    )
    expect(report.added).toBe(5)
    const calls = (target.addSongs as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0][1]).toEqual(['1', '2'])
    expect(calls[2][1]).toEqual(['5'])
  })

  it('添加失败（单批）→ 该批全部计入失败，其他批不受影响', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 3; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    let callCount = 0
    target.addSongs = vi.fn(async () => {
      callCount++
      if (callCount === 2) throw new Error('添加失败')
    })
    const report = await run(
      [1, 2, 3].map((i) => ({ title: `歌${i}`, artist: '某人' })),
      'x',
      target,
      { batchSize: 1 },
    )
    expect(report.added).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].message).toContain('添加失败')
  })

  it('进度回调：matching 与 adding 两个阶段，最终到达 1', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const ratios: Array<[number, string]> = []
    await run([{ title: '晴天' }, { title: '稻香' }], 'x', target, {
      onProgress: (ratio, stage) => ratios.push([ratio, stage]),
    })
    const stages = new Set(ratios.map(([, s]) => s))
    expect(stages).toContain('matching')
    expect(stages).toContain('adding')
    expect(ratios[ratios.length - 1][0]).toBe(1)
  })

  it('建单失败 → 抛出异常，不吞掉', async () => {
    const target = makeTarget(
      { 晴天: [song('1', '晴天', '周杰伦')] },
      { createError: true },
    )
    await expect(run([{ title: '晴天' }], 'x', target)).rejects.toThrow('建单失败')
  })

  it('空输入 → 不建单，报告全零', async () => {
    const target = makeTarget({})
    const report = await run([], 'x', target)
    expect(report.total).toBe(0)
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('全部未匹配 → 不创建空歌单，失败明细保留', async () => {
    const target = makeTarget({})
    const report = await run(
      [{ title: 'A' }, { title: 'B' }],
      'x',
      target,
    )
    expect(target.createPlaylist).not.toHaveBeenCalled()
    expect(report.playlistId).toBe('')
    expect(report.failed).toHaveLength(2)
  })

  it('风控错误（405 操作频繁）→ 分类为 rate-limited', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async () => {
      throw new SearchError('操作频繁，请稍候再试', true)
    })
    const report = await run([{ title: '晴天' }], 'x', target, { searchRetries: 0 })
    expect(report.failed[0].reason).toBe('rate-limited')
    expect(report.failed[0].message).toContain('操作频繁')
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('可重试错误 → 重试后成功', async () => {
    const target = makeTarget({})
    let calls = 0
    target.searchSongs = vi.fn(async () => {
      calls++
      if (calls === 1) throw new SearchError('网络抖动', true)
      return [song('1', '晴天', '周杰伦')]
    })
    const report = await run([{ title: '晴天' }], 'x', target, { searchRetries: 2 })
    expect(calls).toBe(2)
    expect(report.added).toBe(1)
  })

  it('不可重试错误 → 不重试', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async () => {
      throw new SearchError('参数错误', false)
    })
    await run([{ title: '晴天' }], 'x', target, { searchRetries: 2 })
    expect(target.searchSongs).toHaveBeenCalledTimes(1)
  })

  it('搜索限速：相邻两次搜索间隔不小于 searchIntervalMs', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const stamps: number[] = []
    target.searchSongs = vi.fn(async () => {
      stamps.push(Date.now())
      return [song('1', '晴天', '周杰伦')]
    })
    await syncPlaylist([{ title: '晴天' }, { title: '稻香' }], 'x', target, {
      searchIntervalMs: 120,
    })
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(110)
  })
})
