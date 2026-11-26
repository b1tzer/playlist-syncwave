import type { ContextMenuEntry } from './ContextMenu'
import PlatformLogo from './PlatformLogo'

export interface PlaylistMenuTarget {
  id: string
  name: string
  appUrl?: string
  webUrl?: string
}

export interface PlaylistMenuSyncTarget {
  id: string
  name: string
  icon?: string
}

interface PlaylistMenuLabels {
  create: string
  rename: string
  syncToPlatform: (platform: string) => string
  exportM3u: string
  exportCsv: string
  delete: string
}

interface BuildPlaylistMenuOptions<T extends PlaylistMenuTarget> {
  playlist: T
  /** 右键后是否只有该行被选中：仅单选时可重命名/导出/删除 */
  single: boolean
  canRename: boolean
  canDelete: boolean
  syncTargets: PlaylistMenuSyncTarget[]
  syncSelection: Set<string>
  syncDisabled?: boolean
  exportDisabled?: boolean
  createDisabled?: boolean
  /** 仅列表空白区右键时显示新建项；行右键不显示 */
  showCreate?: boolean
  labels: PlaylistMenuLabels
  onCreate: () => void
  onRename?: (playlist: T) => void
  onSync?: (targetId: string, selection: Set<string>) => void
  onExport?: (playlist: T, format: 'm3u' | 'csv') => void
  onDelete?: (playlist: T) => void
  /**
   * 「同步到本地」项：排在所有平台同步目标之前（同步区的第一位），
   * 单选与多选均显示（与 extraItems 不同，不受 single 门禁）。
   */
  localSync?: ContextMenuEntry | null
  /** 平台专属项（打开链接等），仅单选，插在同步与导出之间 */
  extraItems?: ContextMenuEntry[]
}

/** 平台歌单与本地歌单共用的右键菜单构造：公共项只写一份，平台专属项通过 extraItems 注入 */
export function buildPlaylistMenuEntries<T extends PlaylistMenuTarget>({
  playlist,
  single,
  canRename,
  canDelete,
  syncTargets,
  syncSelection,
  syncDisabled = false,
  exportDisabled = false,
  createDisabled = false,
  showCreate = false,
  labels,
  onCreate,
  onRename,
  onSync,
  onExport,
  onDelete,
  localSync = null,
  extraItems = [],
}: BuildPlaylistMenuOptions<T>): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = []
  const pushDivider = () => {
    const last = entries[entries.length - 1]
    if (last && last.type === 'item') {
      entries.push({ type: 'divider', id: `divider-${entries.length}` })
    }
  }

  if (showCreate) {
    entries.push({
      type: 'item',
      id: 'create',
      label: labels.create,
      icon: 'add',
      disabled: createDisabled,
      onSelect: onCreate,
    })
  }
  if (single && canRename) {
    pushDivider()
    entries.push({
      type: 'item',
      id: 'rename',
      label: labels.rename,
      icon: 'edit',
      onSelect: () => onRename?.(playlist),
    })
  }
  // 同步区：「同步到本地」在所有平台目标之前（第一位），随后是各平台
  if (entries.length > 0 && (syncTargets.length > 0 || localSync)) pushDivider()
  if (localSync) {
    entries.push(localSync)
  }
  for (const target of syncTargets) {
    entries.push({
      type: 'item',
      id: `sync-${target.id}`,
      label: labels.syncToPlatform(target.name),
      iconNode: (
        <PlatformLogo
          platform={target.id}
          name={target.name}
          icon={target.icon ?? 'cloud'}
          size="h-4 w-4"
          iconSize="text-sm"
        />
      ),
      disabled: syncDisabled,
      onSelect: () => onSync?.(target.id, syncSelection),
    })
  }
  if (single && extraItems.length > 0) {
    pushDivider()
    entries.push(...extraItems)
  }
  if (single) {
    pushDivider()
    entries.push({
      type: 'item',
      id: 'export-m3u',
      label: labels.exportM3u,
      icon: 'download',
      disabled: exportDisabled,
      onSelect: () => onExport?.(playlist, 'm3u'),
    })
    entries.push({
      type: 'item',
      id: 'export-csv',
      label: labels.exportCsv,
      icon: 'table',
      disabled: exportDisabled,
      onSelect: () => onExport?.(playlist, 'csv'),
    })
  }
  if (single && canDelete) {
    pushDivider()
    entries.push({
      type: 'item',
      id: 'delete',
      label: labels.delete,
      icon: 'delete',
      danger: true,
      onSelect: () => onDelete?.(playlist),
    })
  }
  while (entries.length > 0 && entries[entries.length - 1].type === 'divider') entries.pop()
  return entries
}
