export type Theme = 'light' | 'dark' | 'system'

/** 默认主题（设计规范为深色优先） */
export const DEFAULT_THEME: Theme = 'dark'

const THEMES: readonly Theme[] = ['light', 'dark', 'system']

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

let current: Theme = DEFAULT_THEME
let detachSystemListener: (() => void) | null = null

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyResolved(): void {
  const dark = current === 'dark' || (current === 'system' && systemPrefersDark())
  document.documentElement.classList.toggle('dark', dark)
}

/**
 * 应用主题到文档根元素（Tailwind 语义色经 CSS 变量随 .dark 切换）。
 * system 模式监听 prefers-color-scheme：主进程已把 nativeTheme.themeSource
 * 同步为同一设置，媒体查询随系统外观实时变化。
 */
export function applyTheme(theme: Theme): void {
  current = theme
  detachSystemListener?.()
  detachSystemListener = null
  if (theme === 'system') {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyResolved()
    query.addEventListener('change', onChange)
    detachSystemListener = () => query.removeEventListener('change', onChange)
  }
  applyResolved()
}

/** 启动时用 preload 同步快照恢复主题（非法值回退默认深色），首帧即为正确配色 */
export function restoreTheme(): Theme {
  const saved = window.electronAPI.initialSettings?.theme
  const theme = isTheme(saved) ? saved : DEFAULT_THEME
  applyTheme(theme)
  return theme
}
