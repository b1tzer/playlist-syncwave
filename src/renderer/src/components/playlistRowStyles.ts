/** 平台歌单与本地歌单列表共用的样式，避免两处视觉实现漂移 */

export const playlistListClass = 'min-h-0 flex-1 select-none space-y-0.5 overflow-y-auto p-1.5'

export const playlistEmptyClass = 'px-2 py-2 font-label-md text-label-md text-outline'

export function playlistRowAnimationClass(flashing: boolean, entered: boolean): string {
  return flashing ? 'row-updated' : entered ? '' : 'list-item-enter'
}

export function playlistRowClass(active: boolean, selected = false): string {
  return `flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
    active
      ? 'bg-primary-container/15 text-primary'
      : selected
        ? 'bg-primary/10 text-on-surface'
        : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
  }`
}

export const playlistRenameRowClass =
  'flex w-full items-center gap-1.5 rounded-lg bg-primary-container/15 px-2 py-1.5 text-primary'

export const playlistRenameInputClass =
  'min-w-0 flex-1 border-0 border-b border-primary bg-transparent px-0 py-0.5 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline disabled:opacity-50'

export const playlistNameClass = 'min-w-0 flex-1 font-body-md text-body-md'

export const playlistCountClass = 'font-label-mono text-label-mono text-outline'
