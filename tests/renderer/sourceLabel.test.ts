import { describe, expect, it, vi } from 'vitest'
import type { TranslationKey, TranslateParams } from '../../src/renderer/src/i18n/translations'
import { isLocalSource, syncSourceLabel } from '../../src/renderer/src/sync/sourceLabel'

const zh: Partial<Record<TranslationKey, string>> = {
  'syncHistory.sourceTextImport': '文本导入',
  'syncHistory.sourcePlaylistImport': '歌单导入',
  'syncHistory.sourceLocalPlaylist': '本地',
}

const t = vi.fn((key: TranslationKey, _params?: TranslateParams) => zh[key] ?? String(key))

describe('syncSourceLabel — 任务来源展示文案', () => {
  it('local-playlist 显示为「本地」（不再原样显示 local-playlist）', () => {
    expect(syncSourceLabel('local-playlist', t)).toBe('本地')
  })

  it('文本导入与歌单导入走对应文案', () => {
    expect(syncSourceLabel('text-import', t)).toBe('文本导入')
    expect(syncSourceLabel('playlist-import', t)).toBe('歌单导入')
  })

  it('未知来源原样透出（未来新增来源有兜底，不会显示原始键名）', () => {
    expect(syncSourceLabel('some-future-source', t)).toBe('some-future-source')
  })
})

describe('isLocalSource — 本地来源判定（决定是否使用应用 logo）', () => {
  it('local-playlist 使用应用 logo', () => {
    expect(isLocalSource('local-playlist')).toBe(true)
    expect(isLocalSource('text-import')).toBe(false)
    expect(isLocalSource('playlist-import')).toBe(false)
  })
})
