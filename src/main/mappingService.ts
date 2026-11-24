import { getDatabase } from './appDatabase'
import type { SongMapping } from './mappingStore'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'
import type { SyncChoice } from '@core/models/sync'

export function findMappings(platform: string, query: MatchQuery): SongMapping[] {
  return getDatabase().mappings.findByQuery(platform, query)
}

export function saveAutoMapping(
  platform: string,
  query: MatchQuery,
  song: PlatformSong,
  score: number,
): void {
  getDatabase().mappings.saveAutoMatch(platform, query, song, score)
}

export function saveConfirmedMapping(platform: string, choice: SyncChoice, songId: string): void {
  getDatabase().mappings.saveConfirmed(platform, choice, songId)
}

export function clearMappings(platform: string): void {
  getDatabase().mappings.clearPlatform(platform)
}

export function mappingStats(): Array<{ platform: string; count: number; confirmed: number }> {
  return getDatabase().mappings.countByPlatform()
}
