export type Theme = 'light' | 'dark'

/** 应用主题到文档根元素（Tailwind 语义色经 CSS 变量随 .dark 切换） */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

/** 启动时恢复主题设置（默认深色，非法值回退） */
export async function restoreTheme(): Promise<Theme> {
  let theme: Theme = 'dark'
  try {
    const saved = await window.electronAPI.settings.get('theme', 'dark')
    if (saved === 'light' || saved === 'dark') theme = saved
  } catch {
    // 设置不可用时保持默认深色
  }
  applyTheme(theme)
  return theme
}
