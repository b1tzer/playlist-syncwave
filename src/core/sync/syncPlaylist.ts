import { findBestMatch } from '@core/matcher/matchSong'
import type { MatchQuery } from '@core/models/match'
import {
  SearchError,
  type SyncFailedItem,
  type SyncOptions,
  type SyncReport,
  type SyncTarget,
} from '@core/models/sync'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : '搜索失败'
}

/**
 * 单向同步引擎：
 * 对每首歌搜索目标平台 → 匹配 → 创建歌单 → 分批添加 → 产出报告。
 * 纯逻辑、平台无关，依赖注入 SyncTarget。
 * 搜索限速 + 可重试错误重试，避免触发平台风控。
 */
export async function syncPlaylist(
  queries: MatchQuery[],
  playlistName: string,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const threshold = options.threshold ?? 0.6
  const batchSize = options.batchSize ?? 500
  const searchIntervalMs = options.searchIntervalMs ?? 500
  const searchRetries = options.searchRetries ?? 2
  const notify = (ratio: number, stage: 'matching' | 'adding') =>
    options.onProgress?.(ratio, stage)

  if (queries.length === 0) {
    return {
      playlistName,
      playlistId: '',
      total: 0,
      matched: 0,
      added: 0,
      failed: [],
    }
  }

  const failed: SyncFailedItem[] = []

  // 阶段一：逐首搜索 + 匹配（限速 + 重试）
  const matched: Array<{ query: MatchQuery; songId: string }> = []
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]
    let candidates: Awaited<ReturnType<SyncTarget['searchSongs']>> | null = null
    let lastError: unknown = null

    for (let attempt = 0; attempt <= searchRetries && candidates === null; attempt++) {
      try {
        candidates = await target.searchSongs(query.title, 10)
      } catch (e) {
        lastError = e
        const retryable = e instanceof SearchError ? e.retryable : false
        if (!retryable || attempt === searchRetries) break
        await sleep(Math.min(1000 * 2 ** attempt, 5000))
      }
    }

    if (candidates === null) {
      const isRateLimited =
        lastError instanceof SearchError && /频繁|405/i.test(lastError.message)
      failed.push({
        query,
        reason: isRateLimited ? 'rate-limited' : 'search-failed',
        message: errorMessage(lastError),
      })
    } else {
      const best = findBestMatch(query, candidates, { threshold })
      if (best && best.matched) {
        matched.push({ query, songId: best.candidate.id })
      } else {
        failed.push({
          query,
          reason: 'no-match',
          message: `未找到匹配歌曲：${query.title}${query.artist ? ` - ${query.artist}` : ''}`,
        })
      }
    }
    notify((i + 1) / queries.length, 'matching')

    if (i < queries.length - 1) await sleep(searchIntervalMs)
  }

  // 全部未匹配时不创建空歌单，避免污染用户账号；失败明细仍保留在报告里
  if (matched.length === 0) {
    return {
      playlistName,
      playlistId: '',
      total: queries.length,
      matched: 0,
      added: 0,
      failed,
    }
  }

  const playlistId = await target.createPlaylist(playlistName)

  // 阶段二：分批添加
  let added = 0
  const batchCount = Math.ceil(matched.length / batchSize)
  for (let b = 0; b < batchCount; b++) {
    const batch = matched.slice(b * batchSize, (b + 1) * batchSize)
    try {
      await target.addSongs(playlistId, batch.map((m) => m.songId))
      added += batch.length
    } catch (e) {
      const message = errorMessage(e)
      for (const item of batch) {
        failed.push({ query: item.query, reason: 'search-failed', message })
      }
    }
    notify((b + 1) / Math.max(batchCount, 1), 'adding')
  }

  return {
    playlistName,
    playlistId,
    total: queries.length,
    matched: matched.length,
    added,
    failed,
  }
}
