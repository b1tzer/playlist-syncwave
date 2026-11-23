import { describe, it, expect, vi } from 'vitest'
import { executeSync, planSync, syncPlaylist } from '@core/sync/syncPlaylist'
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

describe('syncPlaylist — 金标准两阶段（T6.4）', () => {
  it('完全匹配（标题+歌手精确）→ 自动选择并建单，无需确认', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦'), song('2', '晴天', '翻唱者')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }],
      'x',
      target,
    )
    expect(report.status).toBe('done')
    expect(report.choices).toHaveLength(0)
    expect(report.added).toBe(1)
    expect(target.addSongs).toHaveBeenCalledWith('pl-x', ['1'])
  })

  it('同歌不同作者（标题精确、歌手不匹配）→ choice-needed，不建单', async () => {
    const target = makeTarget({
      勇气: [song('1', '勇气', '棉子'), song('2', '勇气', '金志文')],
    })
    const report = await run([{ title: '勇气', artist: '梁静茹' }], 'x', target)
    expect(report.status).toBe('choice-needed')
    expect(report.playlistId).toBe('')
    expect(report.choices).toHaveLength(1)
    expect(report.choices[0].candidates.map((c) => c.id)).toEqual(['1', '2'])
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('query 无歌手且唯一标题精确 → 自动选择', async () => {
    const target = makeTarget({ 稻香: [song('1', '稻香', '周杰伦')] })
    const report = await run([{ title: '稻香' }], 'x', target)
    expect(report.status).toBe('done')
    expect(report.added).toBe(1)
  })

  it('query 无歌手且多个标题精确不同歌手 → choice-needed', async () => {
    const target = makeTarget({
      勇气: [song('1', '勇气', '棉子'), song('2', '勇气', '金志文')],
    })
    const report = await run([{ title: '勇气' }], 'x', target)
    expect(report.status).toBe('choice-needed')
    expect(report.choices[0].candidates).toHaveLength(2)
  })

  it('混合：确定的匹配暂不建单，等用户确认选择后一并写入', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '勇气', artist: '梁静茹' }],
      'x',
      target,
    )
    expect(report.status).toBe('choice-needed')
    expect(report.matched).toBe(1)
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('executeSync：确认选择后建单，matched 与选定项一并添加', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const queries = [
      { title: '晴天', artist: '周杰伦' },
      { title: '勇气', artist: '梁静茹' },
    ]
    const plan = await planSync(queries, target, { searchIntervalMs: 0 })
    expect(plan.matched).toHaveLength(1)
    expect(plan.choices).toHaveLength(1)
    const final = await executeSync(plan, [{ choiceIndex: 0, songId: '3' }], 'x', target, {
      searchIntervalMs: 0,
    })
    expect(final.status).toBe('done')
    expect(final.added).toBe(2)
    expect(target.addSongs).toHaveBeenCalledWith('pl-x', ['1', '3'])
  })

  it('executeSync：未选择的 choice 计为 unresolved 失败', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const plan = await planSync(
      [{ title: '晴天', artist: '周杰伦' }, { title: '勇气', artist: '梁静茹' }],
      target,
      { searchIntervalMs: 0 },
    )
    const final = await executeSync(plan, [], 'x', target, { searchIntervalMs: 0 })
    expect(final.status).toBe('done')
    expect(final.added).toBe(1)
    expect(final.failed).toHaveLength(1)
    expect(final.failed[0].reason).toBe('unresolved')
  })
})

describe('planSync — 备选候选搜索验证（T6.4 闭环）', () => {
  it('主候选无匹配、备选精确匹配 → 自动采用备选', async () => {
    const target = makeTarget({
      'Black Country, New Road': [],
      'Basketball Shoes': [song('1', 'Basketball Shoes', 'Black Country, New Road')],
    })
    const plan = await planSync(
      [
        {
          title: 'Black Country, New Road',
          artist: 'Basketball Shoes',
          alternatives: [{ title: 'Basketball Shoes', artist: 'Black Country, New Road' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].songId).toBe('1')
    expect(plan.choices).toHaveLength(0)
    expect(plan.failed).toHaveLength(0)
  })

  it('备选精确匹配（歌手命中）→ 自动选择，不产生 choice', async () => {
    const target = makeTarget({
      'Cory Wong': [],
      Golden: [song('2', 'Golden', 'Harry Styles'), song('3', 'Golden', 'Cory Wong')],
    })
    const plan = await planSync(
      [
        {
          title: 'Cory Wong',
          artist: 'Golden',
          alternatives: [{ title: 'Golden', artist: 'Cory Wong' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].songId).toBe('3')
    expect(plan.choices).toHaveLength(0)
  })

  it('备选多版本且歌手均不匹配 → choice-needed 供用户手动选择', async () => {
    const target = makeTarget({
      'Cory Wong': [],
      Golden: [song('2', 'Golden', 'Harry Styles'), song('3', 'Golden', 'Jill Scott')],
    })
    const plan = await planSync(
      [
        {
          title: 'Cory Wong',
          artist: 'Golden',
          alternatives: [{ title: 'Golden', artist: 'Cory Wong' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.choices).toHaveLength(1)
    expect(plan.choices[0].query).toMatchObject({ title: 'Golden', artist: 'Cory Wong' })
    expect(plan.choices[0].candidates.map((c) => c.id)).toEqual(['2', '3'])
  })

  it('主候选精确匹配 → 不触发备选搜索', async () => {
    const target = makeTarget({
      'Hidden Place': [song('1', 'Hidden Place', 'Björk')],
    })
    target.searchSongs = vi.fn(async (keyword: string) => {
      if (keyword === 'Hidden Place') return [song('1', 'Hidden Place', 'Björk')]
      if (keyword === 'Björk') throw new Error('不应搜索备选')
      return []
    })
    const plan = await planSync(
      [
        {
          title: 'Hidden Place',
          artist: 'Björk',
          alternatives: [{ title: 'Björk', artist: 'Hidden Place' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(target.searchSongs).toHaveBeenCalledTimes(1)
  })

  it('主备均无匹配 → no-match 失败', async () => {
    const target = makeTarget({})
    const plan = await planSync(
      [
        {
          title: '无名乐队',
          artist: '无名歌',
          alternatives: [{ title: '无名歌', artist: '无名乐队' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.failed).toHaveLength(1)
    expect(plan.failed[0].reason).toBe('no-match')
  })
})
