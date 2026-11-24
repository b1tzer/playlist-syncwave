import { findBestMatch } from '@core/matcher/matchSong'
import { classifyCandidates } from '@core/matcher/exactMatch'
import { createLogger, errorMessage } from '@core/logging'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'
import {
  SearchError,
  SyncAbortedError,
  type SyncFailedItem,
  type SyncItemResult,
  type SyncOptions,
  type SyncPlan,
  type SyncReport,
  type SyncSelection,
  type SyncTarget,
} from '@core/models/sync'

const log = createLogger({ module: 'sync.playlist' })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 阶段一：逐首搜索 + 金标准判定。
 * 完全匹配（标题+歌手精确）自动选定；同歌不同作者进入 choices 待手动选择；
 * 其余交给评分引擎。纯逻辑、平台无关，搜索限速 + 可重试错误重试。
 */
export async function planSync(
  queries: MatchQuery[],
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncPlan> {
  const threshold = options.threshold ?? 0.6
  const searchIntervalMs = options.searchIntervalMs ?? 500
  const searchRetries = options.searchRetries ?? 2

  const matched: SyncPlan['matched'] = []
  const choices: SyncPlan['choices'] = []
  const failed: SyncFailedItem[] = []
  const items: SyncItemResult[] = []
  let firstGenre: string | undefined

  log.info('plan.start', '开始匹配计划', { total: queries.length, threshold })

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]

    // 用户停止：下一个检查点立即中止
    if (options.signal?.aborted) {
      log.info('plan.aborted', '匹配计划被用户停止', { done: items.length, total: queries.length })
      throw new SyncAbortedError({ items, failed, total: queries.length })
    }
    // 用户请求跳过当前歌曲：记 skipped 后直接下一首
    if (options.skipCheck?.()) {
      const skipped: SyncItemResult = {
        index: i,
        query,
        status: 'skipped',
        reason: 'skipped',
        message: `已跳过：${query.title}${query.artist ? ` - ${query.artist}` : ''}`,
      }
      items.push(skipped)
      failed.push({ query, reason: 'skipped', message: skipped.message ?? '' })
      options.onStep?.(skipped)
      options.onProgress?.((i + 1) / queries.length, 'matching')
      log.info('plan.item-skipped', '歌曲被用户跳过', { title: query.title })
      continue
    }

    // 映射缓存：人工确认过的映射直接命中，跳过搜索
    if (target.lookupMapping) {
      const hit = target.lookupMapping(query)
      if (hit?.confirmed) {
        matched.push({ query, songId: hit.songId })
        const item: SyncItemResult = {
          index: i,
          query,
          status: 'matched',
          songId: hit.songId,
        }
        items.push(item)
        options.onStep?.(item)
        log.debug('plan.cache-hit', '映射缓存命中，跳过搜索', {
          title: query.title,
          artist: query.artist,
          songId: hit.songId,
        })
        options.onProgress?.((i + 1) / queries.length, 'matching')
        continue
      }
    }

    // 主候选 + 备选候选：主候选无匹配时逐个搜索验证（金标准闭环）
    const attempts: Array<{ title: string; artist?: string; album?: string }> = [
      { title: query.title, artist: query.artist, album: query.album },
      ...(query.alternatives ?? []),
    ]

    let settled:
      | { type: 'matched'; songId: string }
      | { type: 'choice'; attempt: MatchQuery; candidates: PlatformSong[] }
      | null = null
    let lastError: unknown = null
    const budget = options.maxSearchesPerSong ?? 4
    let searchCount = 0

    for (const attempt of attempts) {
      // 搜索关键词策略：优先「歌名 + 歌手」提高召回精度；无精确命中时降级纯歌名
      const keywords = attempt.artist
        ? [`${attempt.title} ${attempt.artist}`, attempt.title]
        : [attempt.title]

      let searchFailed = false
      for (let k = 0; k < keywords.length && settled === null; k++) {
        if (searchCount >= budget) {
          log.warn('plan.budget-exhausted', '单曲搜索预算用尽', {
            title: query.title,
            budget,
          })
          break
        }
        const keyword = keywords[k]
        let candidates: Awaited<ReturnType<SyncTarget['searchSongs']>> | null = null

        for (let retry = 0; retry <= searchRetries && candidates === null; retry++) {
          try {
            searchCount++
            candidates = await target.searchSongs(keyword, 10)
          } catch (e) {
            lastError = e
            const retryable = e instanceof SearchError ? e.retryable : false
            if (!retryable || retry === searchRetries) break
            const waitMs = Math.min(1000 * 2 ** retry, 5000)
            log.warn('plan.search-retry', '搜索失败，准备重试', {
              title: attempt.title,
              keyword,
              attempt: retry + 1,
              waitMs,
              message: errorMessage(e),
            })
            await sleep(waitMs)
            // 重试等待期间用户可能已请求停止：立即响应，不再发起下一次请求
            if (options.signal?.aborted) {
              throw new SyncAbortedError({ items, failed, total: queries.length })
            }
          }
        }

        // 搜索失败不降级：网络/风控错误时换关键词再发请求无意义
        if (candidates === null) {
          searchFailed = true
          break
        }

        const disposition = classifyCandidates(attempt, candidates)
        if (disposition.kind === 'exact') {
          settled = { type: 'matched', songId: disposition.songId }
          if (i === 0 && firstGenre === undefined) {
            firstGenre = candidates.find((c) => c.id === disposition.songId)?.genre
          }
        } else if (disposition.kind === 'title-only') {
          settled = { type: 'choice', attempt, candidates: disposition.candidates }
          if (i === 0 && firstGenre === undefined) {
            firstGenre = disposition.candidates[0]?.genre
          }
        } else {
          const best = findBestMatch(attempt, candidates, { threshold })
          if (best && best.matched) {
            settled = { type: 'matched', songId: best.candidate.id }
            if (i === 0 && firstGenre === undefined) {
              firstGenre = best.candidate.genre
            }
          }
        }

        // 组合关键词无精确命中：降级纯歌名再搜一次
        if (settled === null && k < keywords.length - 1) {
          log.debug('plan.keyword-fallback', '组合关键词无精确命中，降级纯歌名搜索', {
            title: attempt.title,
            artist: attempt.artist,
            keyword,
          })
        }
      }

      if (settled !== null || searchFailed || searchCount >= budget) break
      // no-match：尝试下一个备选候选
    }

    let step: SyncItemResult
    if (settled === null) {
      let fail: SyncFailedItem
      if (lastError !== null) {
        // 限流/可重试判定由平台适配器完成（SearchError 标记），主流程不做平台文案匹配
        const isRateLimited = lastError instanceof SearchError && lastError.rateLimited
        fail = {
          query,
          reason: isRateLimited ? 'rate-limited' : 'search-failed',
          message: errorMessage(lastError),
        }
        log.warn('plan.item-failed', '歌曲匹配失败', {
          title: query.title,
          artist: query.artist,
          reason: fail.reason,
          message: fail.message,
        })
      } else {
        fail = {
          query,
          reason: 'no-match',
          message: `未找到匹配歌曲：${query.title}${query.artist ? ` - ${query.artist}` : ''}`,
        }
        log.info('plan.item-no-match', '未找到匹配歌曲', {
          title: query.title,
          artist: query.artist,
        })
      }
      failed.push(fail)
      step = { index: i, query, status: 'failed', reason: fail.reason, message: fail.message }
    } else if (settled.type === 'matched') {
      matched.push({ query, songId: settled.songId })
      // 自动匹配结果写入缓存（下次可命中）
      target.saveMapping?.(query, settled.songId)
      step = { index: i, query, status: 'matched', songId: settled.songId }
      log.debug('plan.item-matched', '歌曲匹配成功', {
        title: query.title,
        artist: query.artist,
        songId: settled.songId,
      })
    } else {
      choices.push({ query: settled.attempt, candidates: settled.candidates })
      step = { index: i, query: settled.attempt, status: 'choice' }
      log.info('plan.item-choice', '同歌不同作者，进入手动选择', {
        title: query.title,
        artist: query.artist,
        candidates: settled.candidates.length,
      })
    }
    items.push(step)
    options.onStep?.(step)

    options.onProgress?.((i + 1) / queries.length, 'matching')
    if (i < queries.length - 1) await sleep(searchIntervalMs)
  }

  log.info('plan.complete', '匹配计划完成', {
    total: queries.length,
    matched: matched.length,
    choices: choices.length,
    failed: failed.length,
  })

  return { total: queries.length, matched, choices, failed, items, firstGenre }
}

/**
 * 阶段二：用户确认选择后建单并写入。
 * matched 与选定项一并分批添加；未确认的 choice 计为 unresolved。
 */
export async function executeSync(
  plan: SyncPlan,
  selections: SyncSelection[],
  playlistName: string,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const batchSize = options.batchSize ?? 500
  const failed: SyncFailedItem[] = [...plan.failed]
  const items: SyncItemResult[] = plan.items.map((item) => ({ ...item }))

  log.info('execute.start', '开始执行同步', {
    playlistName,
    matched: plan.matched.length,
    choices: plan.choices.length,
    selections: selections.length,
  })

  for (let i = 0; i < plan.choices.length; i++) {
    const choice = plan.choices[i]
    const selection = selections.find((s) => s.choiceIndex === i)
    const candidate = selection
      ? choice.candidates.find((c) => c.id === selection.songId)
      : undefined
    const item = items.find((it) => it.status === 'choice' && it.query === choice.query)
    if (!candidate) {
      const fail: SyncFailedItem = {
        query: choice.query,
        reason: 'unresolved',
        message: `同歌不同作者，未选择版本：${choice.query.title}${choice.query.artist ? ` - ${choice.query.artist}` : ''}`,
      }
      failed.push(fail)
      if (item) {
        item.status = 'failed'
        item.reason = fail.reason
        item.message = fail.message
      }
      log.warn('execute.choice-unresolved', '同歌不同作者，未选择版本', {
        title: choice.query.title,
        artist: choice.query.artist,
      })
      continue
    }
    if (item) {
      item.status = 'matched'
      item.songId = candidate.id
    }
  }

  // 写入顺序必须与文本清单一致：自动匹配与手动确认合并后，按原始输入 index 重排。
  // （先 matched 再 choices 的拼接会把需要手动选择的歌挪到末尾，打乱用户文本顺序）
  const pending: Array<{ query: MatchQuery; songId: string }> = items
    .filter(
      (it): it is SyncItemResult & { songId: string } =>
        it.status === 'matched' && typeof it.songId === 'string' && it.songId !== '',
    )
    .sort((a, b) => a.index - b.index)
    .map((it) => ({ query: it.query, songId: it.songId }))

  const baseReport = {
    playlistName,
    playlistId: '',
    total: plan.total,
    matched: plan.matched.length,
    added: 0,
    failed,
    choices: [],
    items,
    firstGenre: plan.firstGenre,
  }

  // 全部未匹配/未确认时不创建空歌单，避免污染用户账号
  if (pending.length === 0) {
    log.warn('execute.skipped', '无可添加歌曲，跳过创建歌单', { playlistName })
    return { status: 'done', ...baseReport }
  }

  // 用户停止：建单前最后检查，避免建出空歌单
  if (options.signal?.aborted) {
    throw new SyncAbortedError({
      items,
      failed,
      total: plan.total,
      matched: plan.matched.length,
      added: 0,
    })
  }

  const playlistId = await target.createPlaylist(playlistName)
  log.info('execute.playlist-created', '目标歌单已创建', { playlistName, playlistId })

  let added = 0
  const batchCount = Math.ceil(pending.length / batchSize)
  for (let b = 0; b < batchCount; b++) {
    // 用户停止：批次之间响应，已写入的批次保留
    if (options.signal?.aborted) {
      throw new SyncAbortedError({
        items,
        failed,
        total: plan.total,
        matched: plan.matched.length,
        added,
        playlistId,
      })
    }
    const batch = pending.slice(b * batchSize, (b + 1) * batchSize)
    try {
      await target.addSongs(playlistId, batch.map((m) => m.songId))
      added += batch.length
      log.debug('execute.batch-added', '批次写入成功', {
        playlistId,
        batch: b + 1,
        totalBatches: batchCount,
        count: batch.length,
      })
    } catch (e) {
      const message = errorMessage(e)
      log.error('execute.batch-failed', '批次写入失败', e, {
        playlistId,
        batch: b + 1,
        count: batch.length,
      })
      for (const pendingItem of batch) {
        failed.push({ query: pendingItem.query, reason: 'add-failed', message })
        const item = items.find((it) => it.query === pendingItem.query)
        if (item) {
          item.status = 'failed'
          item.reason = 'add-failed'
          item.message = message
        }
      }
    }
    options.onProgress?.((b + 1) / Math.max(batchCount, 1), 'adding')
  }

  log.info('execute.complete', '同步执行完成', {
    playlistName,
    playlistId,
    total: plan.total,
    added,
    failed: failed.length,
  })

  return {
    status: 'done',
    playlistName,
    playlistId,
    total: plan.total,
    matched: plan.matched.length,
    added,
    failed,
    choices: [],
    items,
    firstGenre: plan.firstGenre,
  }
}

/** 存在同歌不同作者时的 choice-needed 报告（未建单） */
export function choiceNeededReport(playlistName: string, plan: SyncPlan): SyncReport {
  return {
    status: 'choice-needed',
    playlistName,
    playlistId: '',
    total: plan.total,
    matched: plan.matched.length,
    added: 0,
    failed: plan.failed,
    choices: plan.choices,
    items: plan.items,
    firstGenre: plan.firstGenre,
  }
}

/**
 * 单向同步入口：先搜索判定，全自动则直接建单写入；
 * 存在同歌不同作者时返回 choice-needed，等待用户确认后调 executeSync 完成。
 */
export async function syncPlaylist(
  queries: MatchQuery[],
  playlistName: string,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const plan = await planSync(queries, target, options)

  if (plan.choices.length > 0) {
    log.info('sync.choice-needed', '同步等待用户确认', {
      playlistName,
      choices: plan.choices.length,
    })
    return choiceNeededReport(playlistName, plan)
  }

  return executeSync(plan, [], playlistName, target, options)
}
