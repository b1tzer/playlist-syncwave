import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  LOCALES,
  normalizeLocale,
  translate,
  type Locale,
  type TranslationKey,
  type TranslateParams,
} from './translations'
import { setLogLocale } from '@core/logging'
import { createRendererLogger } from '../logging/rendererLogger'

const log = createRendererLogger('renderer.i18n')

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: TranslationKey, params?: TranslateParams) => string
  formatDate: (date: Date) => string
  /** 带年月日的完整时间（如 2026/11/25 11:35:40），按当前系统时区与界面语言格式化 */
  formatDateTime: (date: Date) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

/** 语言偏好持久化到主进程 SQLite（settings 表），启动时恢复。 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('zh-CN')

  useEffect(() => {
    let cancelled = false
    window.electronAPI.settings
      .get('language', 'zh-CN')
      .then((v) => {
        if (!cancelled) setLocaleState(normalizeLocale(v))
      })
      .catch((e) => {
        log.warn('i18n.restore-failed', '恢复语言偏好失败', e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = translate(locale, 'app.title')
    // 日志消息语言跟随界面语言
    setLogLocale(locale)
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    window.electronAPI.settings
      .set('language', next)
      .then(() => log.info('i18n.language-saved', '语言偏好已保存', { locale: next }))
      .catch((e) => log.error('i18n.language-save-failed', '语言偏好保存失败', e, { locale: next }))
  }, [])

  const t = useCallback(
    (key: TranslationKey, params?: TranslateParams) => translate(locale, key, params),
    [locale],
  )

  const formatDate = useCallback((date: Date) => date.toLocaleDateString(locale), [locale])

  // toLocaleString 由 V8/Chromium 的 ICU 提供，跨平台（macOS/Windows/Linux）行为一致，
  // 且基于传入 Date 的绝对时间按「当前」系统时区换算：OS 修改时区后无需重启即可正确显示。
  const formatDateTime = useCallback(
    (date: Date) =>
      `${date.toLocaleDateString(locale)} ${date.toLocaleTimeString(locale, { hour12: false })}`,
    [locale],
  )

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, formatDate, formatDateTime }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用')
  return ctx
}

export { LOCALES, type Locale }
