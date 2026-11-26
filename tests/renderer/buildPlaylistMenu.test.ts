import { describe, expect, it } from 'vitest'
import type { ContextMenuEntry } from '../../src/renderer/src/components/ContextMenu'
import { buildPlaylistMenuEntries } from '../../src/renderer/src/components/buildPlaylistMenu'

const labels = {
  create: '新建',
  rename: '重命名',
  syncToPlatform: (platform: string) => `同步到 ${platform}`,
  exportM3u: '导出 M3U',
  exportCsv: '导出 CSV',
  delete: '删除',
}

const base = {
  playlist: { id: 'p1', name: '我的歌单' },
  canRename: true,
  canDelete: true,
  syncTargets: [
    { id: 'qqmusic', name: 'QQ音乐' },
    { id: 'applemusic', name: 'Apple Music' },
  ],
  syncSelection: new Set(['p1']),
  labels,
  onCreate: () => {},
}

const localSync: ContextMenuEntry = {
  type: 'item',
  id: 'save-local',
  label: '同步到本地',
  onSelect: () => {},
}

/** 仅保留 item 条目并按序取 id（divider 只作视觉分组） */
const itemIds = (entries: ContextMenuEntry[]) =>
  entries.filter((e) => e.type === 'item').map((e) => e.id)

describe('buildPlaylistMenuEntries — 右键菜单构造', () => {
  it('单选：「同步到本地」位于所有平台同步目标之前（第一位）', () => {
    const entries = buildPlaylistMenuEntries({
      ...base,
      single: true,
      canRename: true,
      canDelete: true,
      localSync,
      onExport: () => {},
      onDelete: () => {},
    })
    expect(itemIds(entries)).toEqual([
      'rename',
      'save-local',
      'sync-qqmusic',
      'sync-applemusic',
      'export-m3u',
      'export-csv',
      'delete',
    ])
    // save-local 排在第一个平台目标之前
    const saveIdx = itemIds(entries).indexOf('save-local')
    const firstPlatformIdx = itemIds(entries).indexOf('sync-qqmusic')
    expect(saveIdx).toBeGreaterThanOrEqual(0)
    expect(saveIdx).toBeLessThan(firstPlatformIdx)
  })

  it('多选：「同步到本地」与平台目标仍显示，重命名/导出/删除隐藏', () => {
    const entries = buildPlaylistMenuEntries({
      ...base,
      single: false,
      canRename: true,
      canDelete: true,
      localSync,
      onExport: () => {},
      onDelete: () => {},
    })
    const ids = itemIds(entries)
    expect(ids).toContain('save-local')
    expect(ids).toContain('sync-qqmusic')
    expect(ids).toContain('sync-applemusic')
    expect(ids).not.toContain('rename')
    expect(ids).not.toContain('export-m3u')
    expect(ids).not.toContain('delete')
    // 多选时 save-local 仍在平台目标之前
    expect(ids.indexOf('save-local')).toBeLessThan(ids.indexOf('sync-qqmusic'))
  })

  it('未提供 localSync 时不显示该项', () => {
    const entries = buildPlaylistMenuEntries({
      ...base,
      single: true,
      canDelete: true,
    })
    expect(itemIds(entries)).not.toContain('save-local')
  })

  it('localSync 的 disabled 与 onSelect 原样透传', () => {
    const disabledLocal: ContextMenuEntry = {
      ...localSync,
      disabled: true,
    }
    const entries = buildPlaylistMenuEntries({
      ...base,
      single: false,
      localSync: disabledLocal,
    })
    const entry = entries.find((e) => e.type === 'item' && e.id === 'save-local')
    expect(entry).toMatchObject({ id: 'save-local', disabled: true })
  })

  it('extraItems（打开链接等）仅单选显示，多选隐藏', () => {
    const extra: ContextMenuEntry = {
      type: 'item',
      id: 'open-web',
      label: '浏览器打开',
      onSelect: () => {},
    }
    const single = buildPlaylistMenuEntries({
      ...base,
      single: true,
      canDelete: true,
      extraItems: [extra],
    })
    expect(itemIds(single)).toContain('open-web')
    const multi = buildPlaylistMenuEntries({
      ...base,
      single: false,
      extraItems: [extra],
    })
    expect(itemIds(multi)).not.toContain('open-web')
  })

  it('分隔线不出现在菜单首尾（视觉分组卫生）', () => {
    const entries = buildPlaylistMenuEntries({
      ...base,
      single: true,
      canRename: true,
      canDelete: true,
      localSync,
      onExport: () => {},
      onDelete: () => {},
    })
    expect(entries[0].type).toBe('item')
    expect(entries[entries.length - 1].type).toBe('item')
  })
})
