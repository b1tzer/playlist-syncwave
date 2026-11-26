import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRendererLogger } from '../logging/rendererLogger'
import { LOCALES, useI18n } from '../i18n'
import ToggleSwitch from './ToggleSwitch'
import Tooltip from './Tooltip'
import { notify } from './toast'
import { notifyError } from '../utils/notifyError'
import { applyTheme, isTheme, DEFAULT_THEME, type Theme } from '../theme'
import { SYNC_TUNING_DEFAULTS, SYNC_TUNING_RANGE, THRESHOLD_PRESETS, type ThresholdPreset } from '@core/sync/tuning'
import type { UpdateStatus } from '../../../preload/index'

const log = createRendererLogger('renderer.settings')

interface SettingRowProps {
  icon: string
  title: string
  description: string
  children?: ReactNode
  /** 控件下方补充内容（如更新状态行） */
  extra?: ReactNode
}

function SettingRow({ icon, title, description, children, extra }: SettingRowProps) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-lg text-on-surface-variant">{icon}</span>
          <div>
            <p className="font-body-md text-body-md font-medium">{title}</p>
            <p className="font-label-sm text-label-sm text-on-surface-variant">{description}</p>
          </div>
        </div>
        {children}
      </div>
      {extra && <div className="mt-2 pl-8">{extra}</div>}
    </div>
  )
}

const SECTION_ORDER = [
  { id: 'appearance', labelKey: 'settings.sectionAppearance' },
  { id: 'general', labelKey: 'settings.sectionGeneral' },
  { id: 'network', labelKey: 'settings.sectionNetwork' },
  { id: 'advanced', labelKey: 'settings.sectionAdvanced' },
  { id: 'data', labelKey: 'settings.sectionData' },
  { id: 'about', labelKey: 'settings.sectionAbout' },
] as const

type SectionId = (typeof SECTION_ORDER)[number]['id']

interface RowDef {
  section: SectionId
  icon: string
  title: string
  desc: string
  control: ReactNode
  extra?: ReactNode
}

/** 当前阈值映射到最近的语义预设档位（历史自定义值取最近档） */
function nearestPreset(value: number): ThresholdPreset {
  return (Object.keys(THRESHOLD_PRESETS) as ThresholdPreset[]).reduce((best, cur) =>
    Math.abs(THRESHOLD_PRESETS[cur] - value) < Math.abs(THRESHOLD_PRESETS[best] - value) ? cur : best,
  )
}

const PRESET_LABEL_KEYS: Record<ThresholdPreset, 'settings.matchLoose' | 'settings.matchBalanced' | 'settings.matchStrict'> = {
  loose: 'settings.matchLoose',
  balanced: 'settings.matchBalanced',
  strict: 'settings.matchStrict',
}

export default function SettingsView() {
  const { t, locale, setLocale } = useI18n()
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(true)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [syncThreshold, setSyncThreshold] = useState(SYNC_TUNING_DEFAULTS.threshold)
  const [syncRetries, setSyncRetries] = useState(SYNC_TUNING_DEFAULTS.searchRetries)
  const [syncInterval, setSyncInterval] = useState(SYNC_TUNING_DEFAULTS.searchIntervalMs)
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyDraft, setProxyDraft] = useState('')
  const [proxyTesting, setProxyTesting] = useState(false)
  /** 已通过连通性测试的代理地址；仅当与当前输入一致时才允许应用 */
  const [proxyTestedOk, setProxyTestedOk] = useState('')
  /** Apply 按钮悬浮即时提示（未测通过时显示引导语，锚点 = 按钮底边中心） */
  const [proxyApplyTip, setProxyApplyTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.electronAPI.initialSettings?.theme
    return isTheme(saved) ? saved : DEFAULT_THEME
  })
  const [version, setVersion] = useState('')
  const [search, setSearch] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [cacheConfirm, setCacheConfirm] = useState(false)
  /** 设置从 SQLite 恢复完成前，防抖 effect 不回写 */
  const restoredRef = useRef(false)
  const cacheConfirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // --- 代理 ---

  /** 代理必须先测后用：仅当当前输入与已测通过的地址一致才可应用（点击拦截 + Enter 双保险） */
  const proxyTestPassed = proxyDraft.trim() !== '' && proxyDraft.trim() === proxyTestedOk

  const handleProxyApply = async () => {
    if (!proxyTestPassed) {
      notify('warning', t('settings.proxyTestFirst'))
      return
    }
    try {
      await window.electronAPI.proxy.set(proxyDraft.trim())
      setProxyUrl(proxyDraft.trim())
      log.info('settings.proxy-apply', '代理已应用', { url: proxyDraft.trim() })
      notify('success', t('settings.proxyApplied'))
    } catch (e) {
      log.error('settings.proxy-apply-failed', '应用代理失败', e)
      notifyError(e, t('settings.proxyApplyFailed'))
    }
  }

  const handleProxyClear = async () => {
    try {
      await window.electronAPI.proxy.set('')
      setProxyUrl('')
      setProxyDraft('')
      setProxyTestedOk('')
      log.info('settings.proxy-clear', '代理已清除')
      notify('success', t('settings.proxyCleared'))
    } catch (e) {
      log.error('settings.proxy-clear-failed', '清除代理失败', e)
      notifyError(e, t('settings.proxyApplyFailed'))
    }
  }

  const handleProxyTest = async () => {
    const url = proxyDraft.trim()
    if (!url || proxyTesting) return
    setProxyTesting(true)
    try {
      const result = await window.electronAPI.proxy.test(url)
      if (result.ok) {
        setProxyTestedOk(url)
        log.info('settings.proxy-test-ok', '代理连通性测试通过', { latencyMs: result.latencyMs })
        notify('success', t('settings.proxyTestOk', { ms: String(result.latencyMs ?? 0) }))
      } else {
        setProxyTestedOk('')
        log.warn('settings.proxy-test-failed', '代理连通性测试失败', { error: result.error })
        notifyError(new Error(result.error ?? 'proxy test failed'), t('settings.proxyTestFailed'))
      }
    } catch (e) {
      setProxyTestedOk('')
      log.error('settings.proxy-test-failed', '代理连通性测试失败', e)
      notifyError(e, t('settings.proxyTestFailed'))
    } finally {
      setProxyTesting(false)
    }
  }

  // --- 主题：切换失败回滚 ---

  const handleThemeChange = (next: Theme) => {
    const prev = theme
    setTheme(next)
    applyTheme(next)
    window.electronAPI.settings
      .set('theme', next)
      .then(() => log.info('settings.theme', '主题已切换', { theme: next }))
      .catch((e) => {
        setTheme(prev)
        applyTheme(prev)
        log.error('settings.theme-save-failed', '主题保存失败', e, { theme: next })
        notifyError(e, t('settings.saveFailed'))
      })
  }

  // --- 匹配策略预设与高级参数 ---

  const handlePresetChange = (preset: ThresholdPreset) => {
    const v = THRESHOLD_PRESETS[preset]
    setSyncThreshold(v)
    window.electronAPI.settings
      .set('syncThreshold', v)
      .then(() => log.info('settings.match-strategy', '匹配策略已切换', { preset, threshold: v }))
      .catch((e) => notifyError(e, t('settings.saveFailed')))
  }

  const handleResetTuning = () => {
    const { threshold, searchRetries, searchIntervalMs } = SYNC_TUNING_DEFAULTS
    setSyncThreshold(threshold)
    setSyncRetries(searchRetries)
    setSyncInterval(searchIntervalMs)
    Promise.all([
      window.electronAPI.settings.set('syncThreshold', threshold),
      window.electronAPI.settings.set('syncRetries', searchRetries),
      window.electronAPI.settings.set('syncSearchInterval', searchIntervalMs),
    ])
      .then(() => {
        log.info('settings.tuning-reset', '同步参数已恢复默认')
        notify('success', t('settings.resetDone'))
      })
      .catch((e) => notifyError(e, t('settings.saveFailed')))
  }

  // --- 滑块防抖回写（恢复完成前不触发） ---

  useEffect(() => {
    if (!restoredRef.current) return
    const id = setTimeout(() => {
      window.electronAPI.settings.set('syncRetries', syncRetries).catch(() => {})
    }, 350)
    return () => clearTimeout(id)
  }, [syncRetries])

  useEffect(() => {
    if (!restoredRef.current) return
    const id = setTimeout(() => {
      window.electronAPI.settings.set('syncSearchInterval', syncInterval).catch(() => {})
    }, 350)
    return () => clearTimeout(id)
  }, [syncInterval])

  // --- 危险区：清空缓存（两步确认） ---

  const handleClearCache = () => {
    if (!cacheConfirm) {
      setCacheConfirm(true)
      clearTimeout(cacheConfirmTimer.current)
      cacheConfirmTimer.current = setTimeout(() => setCacheConfirm(false), 4_000)
      return
    }
    clearTimeout(cacheConfirmTimer.current)
    setCacheConfirm(false)
    window.electronAPI.cache
      .clear()
      .then(({ playlists, songs }) => {
        log.info('settings.cache-cleared', '歌曲缓存已清空', { playlists, songs })
        notify('success', t('settings.clearCacheDone', { playlists: String(playlists), songs: String(songs) }))
      })
      .catch((e) => {
        log.error('settings.cache-clear-failed', '清空缓存失败', e)
        notifyError(e, t('settings.clearCache'))
      })
  }

  // --- 关于：复制版本号 ---

  const handleCopyVersion = async () => {
    try {
      await navigator.clipboard.writeText(version ? `SyncWave v${version}` : 'SyncWave')
      notify('success', t('settings.versionCopied'))
    } catch (e) {
      log.error('settings.copy-version-failed', '复制版本号失败', e)
      notifyError(e, t('settings.saveFailed'))
    }
  }

  // --- 自动更新状态流转 ---

  useEffect(() => {
    const offStatus = window.electronAPI.updater.onStatus((status) => {
      log.debug('settings.update-status', '更新状态变化', { state: status.state })
      setUpdateStatus(status)
    })
    // 菜单「检查更新」：触发手动检查
    const offCheck = window.electronAPI.updater.onCheckRequested(() => {
      log.info('settings.update-check', '菜单触发检查更新')
      setUpdateStatus({ state: 'checking' })
      window.electronAPI.updater
        .check()
        .catch(() => setUpdateStatus({ state: 'error', message: t('settings.updateDevMode') }))
    })
    return () => {
      offStatus()
      offCheck()
    }
  }, [t])

  // --- 从 SQLite 恢复设置；开机启动读取系统登录项真实状态 ---

  useEffect(() => {
    window.electronAPI.settings
      .getAll()
      .then((all) => {
        setAutoUpdateEnabled(typeof all.autoUpdateEnabled === 'boolean' ? all.autoUpdateEnabled : true)
        if (typeof all.syncThreshold === 'number') setSyncThreshold(all.syncThreshold)
        if (typeof all.syncRetries === 'number') setSyncRetries(all.syncRetries)
        if (typeof all.syncSearchInterval === 'number') setSyncInterval(all.syncSearchInterval)
        log.debug('settings.restored', '设置已恢复', { keys: Object.keys(all) })
      })
      .catch((e) => {
        log.warn('settings.restore-failed', '设置恢复失败', e)
      })
      .finally(() => {
        restoredRef.current = true
      })
    window.electronAPI
      .getAutoLaunch()
      .then(setAutoLaunch)
      .catch((e) => {
        log.warn('settings.auto-launch-read-failed', '读取开机启动状态失败', e)
      })
    window.electronAPI.proxy
      .get()
      .then((url) => {
        setProxyUrl(url)
        setProxyDraft(url)
        // 已生效的代理视为已验证：恢复后可立即重新应用；改动输入后需重新测试
        setProxyTestedOk(url)
      })
      .catch((e) => {
        log.warn('settings.proxy-read-failed', '读取代理设置失败', e)
      })
    window.electronAPI
      .getVersion()
      .then(setVersion)
      .catch((e) => {
        log.debug('settings.version', '查询应用版本失败', e)
      })
    return () => clearTimeout(cacheConfirmTimer.current)
  }, [])

  // --- 组装分组行 ---

  const updateStatusText = (() => {
    if (!updateStatus) return null
    switch (updateStatus.state) {
      case 'checking':
        return t('settings.updateChecking')
      case 'not-available':
        return t('settings.updateLatest')
      case 'available':
        return t('settings.updateAvailable', { version: updateStatus.version })
      case 'downloading':
        return t('settings.updateDownloading', { percent: String(updateStatus.percent) })
      case 'downloaded':
        return t('settings.updateDownloadedManual')
      case 'error':
        return t('settings.updateFailed')
    }
  })()

  const activePreset = nearestPreset(syncThreshold)

  const rows: RowDef[] = [
    {
      section: 'appearance',
      icon: 'dark_mode',
      title: t('settings.theme'),
      desc: t('settings.themeDesc'),
      control: (
        <div className="flex gap-1 rounded-lg border border-outline-variant bg-surface-container-highest p-1">
          {(['light', 'dark', 'system'] as const).map((th) => (
            <button
              key={th}
              aria-pressed={theme === th}
              onClick={() => handleThemeChange(th)}
              className={`rounded-md px-3 py-1 font-label-sm text-label-sm transition-colors ${
                theme === th
                  ? 'bg-primary text-on-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {th === 'light' ? t('settings.light') : th === 'dark' ? t('settings.dark') : t('settings.system')}
            </button>
          ))}
        </div>
      ),
    },
    {
      section: 'appearance',
      icon: 'language',
      title: t('settings.language'),
      desc: t('settings.languageDesc'),
      control: (
        <div className="flex gap-1 rounded-lg border border-outline-variant bg-surface-container-highest p-1">
          {LOCALES.map((l) => (
            <button
              key={l}
              aria-pressed={locale === l}
              onClick={() => {
                log.info('settings.language', '切换语言', { locale: l })
                setLocale(l)
              }}
              className={`rounded-md px-3 py-1 font-label-sm text-label-sm transition-colors ${
                locale === l
                  ? 'bg-primary text-on-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {l === 'zh-CN' ? t('settings.zh') : t('settings.en')}
            </button>
          ))}
        </div>
      ),
    },
    {
      section: 'general',
      icon: 'power_settings_new',
      title: t('settings.autoLaunch'),
      desc: t('settings.autoLaunchDesc'),
      control: (
        <ToggleSwitch
          checked={autoLaunch}
          ariaLabel={t('settings.autoLaunch')}
          onChange={(next) => {
            setAutoLaunch(next)
            window.electronAPI
              .setAutoLaunch(next)
              .then(() => log.info('settings.auto-launch', '开机启动设置已应用', { enabled: next }))
              .catch((e) => {
                setAutoLaunch(!next)
                log.error('settings.auto-launch', '开机启动设置失败', e, { enabled: next })
                notifyError(e, t('settings.saveFailed'))
              })
          }}
        />
      ),
    },
    {
      section: 'general',
      icon: 'system_update',
      title: t('settings.update'),
      desc: t('settings.updateDesc'),
      control: (
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={autoUpdateEnabled}
            ariaLabel={t('settings.update')}
            onChange={(next) => {
              setAutoUpdateEnabled(next)
              window.electronAPI.settings
                .set('autoUpdateEnabled', next)
                .then(() => log.info('settings.auto-update', '自动更新开关已保存', { enabled: next }))
                .catch((e) => {
                  setAutoUpdateEnabled(!next)
                  log.error('settings.auto-update', '自动更新设置保存失败', e, { enabled: next })
                  notifyError(e, t('settings.saveFailed'))
                })
            }}
          />
          {updateStatus?.state === 'downloaded' ? (
            <button
              onClick={() => {
                log.info('settings.update-install', '重新打开安装包')
                window.electronAPI.updater
                  .openInstaller()
                  .catch((e) => {
                    log.error('settings.update-install-failed', '打开更新失败', e)
                    setUpdateStatus({ state: 'error', message: t('settings.updateFailed') })
                  })
              }}
              className="rounded-lg bg-primary px-3 py-1.5 font-label-md text-label-md font-medium text-on-primary transition-colors hover:brightness-110"
            >
              {t('settings.updateOpenInstaller')}
            </button>
          ) : (
            <button
              onClick={() => {
                log.info('settings.update-check', '手动检查更新')
                setUpdateStatus({ state: 'checking' })
                window.electronAPI.updater
                  .check()
                  .catch(() => setUpdateStatus({ state: 'error', message: t('settings.updateDevMode') }))
              }}
              className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high"
            >
              {t('settings.updateCheck')}
            </button>
          )}
        </div>
      ),
      extra: updateStatusText && (
        <p className="font-label-sm text-label-sm text-on-surface-variant">{updateStatusText}</p>
      ),
    },
    {
      section: 'network',
      icon: 'router',
      title: t('settings.proxy'),
      desc: t('settings.proxyDesc'),
      control: (
        <div className="flex items-center gap-2">
          <input
            value={proxyDraft}
            onChange={(e) => setProxyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleProxyApply()
            }}
            placeholder={t('settings.proxyPlaceholder')}
            aria-label={t('settings.proxy')}
            className="w-48 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary"
          />
          <button
            onClick={() => void handleProxyTest()}
            disabled={proxyTesting || proxyDraft.trim() === ''}
            className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high hover:text-primary disabled:opacity-50"
          >
            {proxyTesting ? t('settings.proxyTesting') : t('settings.proxyTest')}
          </button>
          {/* disabled 按钮不响应鼠标事件：悬浮事件挂外层 span，即时 Tooltip 显示引导语 */}
          <span
            className="flex items-center"
            onMouseEnter={(e) => {
              if (proxyTestPassed) return
              const rect = e.currentTarget.getBoundingClientRect()
              setProxyApplyTip({
                x: rect.left + rect.width / 2,
                y: rect.bottom,
                text: t('settings.proxyTestFirst'),
              })
            }}
            onMouseLeave={() => setProxyApplyTip(null)}
          >
            <button
              onClick={() => void handleProxyApply()}
              disabled={!proxyTestPassed}
              aria-disabled={!proxyTestPassed}
              className={`rounded-lg border px-3 py-1.5 font-label-md text-label-md transition-colors ${
                proxyTestPassed
                  ? 'border-primary text-primary hover:bg-primary/10'
                  : 'border-outline-variant text-on-surface hover:bg-surface-container-high disabled:opacity-50 disabled:hover:bg-transparent'
              }`}
            >
              {t('settings.proxyApply')}
            </button>
          </span>
          {proxyUrl !== '' && (
            <button
              onClick={() => void handleProxyClear()}
              title={t('settings.proxyClear')}
              aria-label={t('settings.proxyClear')}
              className="flex items-center rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          )}
        </div>
      ),
    },
    {
      section: 'advanced',
      icon: 'tune',
      title: t('settings.matchStrategy'),
      desc: t('settings.matchStrategyDesc'),
      control: (
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-outline-variant bg-surface-container-highest p-1">
            {(Object.keys(THRESHOLD_PRESETS) as ThresholdPreset[]).map((p) => (
              <button
                key={p}
                aria-pressed={activePreset === p}
                onClick={() => handlePresetChange(p)}
                className={`rounded-md px-3 py-1 font-label-sm text-label-sm transition-colors ${
                  activePreset === p
                    ? 'bg-primary text-on-primary'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {t(PRESET_LABEL_KEYS[p])}
              </button>
            ))}
          </div>
          <span className="w-20 text-right font-label-mono text-label-mono text-on-surface-variant">
            {t('settings.matchValue', { value: syncThreshold.toFixed(2) })}
          </span>
        </div>
      ),
    },
    {
      section: 'advanced',
      icon: 'replay',
      title: t('settings.syncRetries'),
      desc: t('settings.syncRetriesDesc'),
      control: (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={SYNC_TUNING_RANGE.searchRetries.min}
            max={SYNC_TUNING_RANGE.searchRetries.max}
            step={1}
            value={syncRetries}
            aria-label={t('settings.syncRetries')}
            onChange={(e) => setSyncRetries(Number(e.target.value))}
            className="w-40 accent-primary"
          />
          <span className="w-10 text-right font-label-mono text-label-mono text-on-surface">
            {syncRetries}
          </span>
        </div>
      ),
    },
    {
      section: 'advanced',
      icon: 'speed',
      title: t('settings.syncInterval'),
      desc: t('settings.syncIntervalDesc'),
      control: (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={SYNC_TUNING_RANGE.searchIntervalMs.min}
            max={SYNC_TUNING_RANGE.searchIntervalMs.max}
            step={100}
            value={syncInterval}
            aria-label={t('settings.syncInterval')}
            onChange={(e) => setSyncInterval(Number(e.target.value))}
            className="w-40 accent-primary"
          />
          <span className="w-16 text-right font-label-mono text-label-mono text-on-surface">
            {t('settings.syncIntervalUnit', { value: syncInterval })}
          </span>
        </div>
      ),
    },
    {
      section: 'data',
      icon: 'folder_delete',
      title: t('settings.clearCache'),
      desc: t('settings.clearCacheDesc'),
      control: cacheConfirm ? (
        <div className="flex items-center gap-2">
          <span className="font-label-sm text-label-sm text-error">{t('settings.clearCacheConfirm')}</span>
          <button
            onClick={handleClearCache}
            className="rounded-lg bg-error px-3 py-1.5 font-label-md text-label-md font-medium text-on-error transition-colors hover:brightness-110"
          >
            {t('settings.clearCache')}
          </button>
          <button
            onClick={() => {
              clearTimeout(cacheConfirmTimer.current)
              setCacheConfirm(false)
            }}
            className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high"
          >
            {t('settings.cancel')}
          </button>
        </div>
      ) : (
        <button
          onClick={handleClearCache}
          className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:border-error hover:text-error"
        >
          {t('settings.clearCache')}
        </button>
      ),
    },
    {
      section: 'about',
      icon: 'info',
      title: t('settings.about'),
      desc: t('settings.aboutDesc'),
      control: (
        <div className="flex items-center gap-3">
          <span className="font-label-mono text-label-mono text-outline">
            {version ? `SyncWave v${version}` : 'Electron · React · Tailwind'}
          </span>
          <button
            onClick={() => void handleCopyVersion()}
            disabled={!version}
            className="flex items-center gap-1 rounded-lg border border-outline-variant px-2.5 py-1 font-label-sm text-label-sm text-on-surface transition-colors hover:bg-surface-container-high hover:text-primary disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">content_copy</span>
            {t('settings.copyVersion')}
          </button>
        </div>
      ),
    },
  ]

  const query = search.trim().toLowerCase()
  const matchesSearch = (row: RowDef): boolean => {
    if (!query) return true
    return row.title.toLowerCase().includes(query) || row.desc.toLowerCase().includes(query)
  }
  const visibleRows = rows.filter((row) => {
    if (!matchesSearch(row)) return false
    // 高级区默认折叠；搜索命中时临时展开
    if (row.section === 'advanced') return advancedOpen || query !== ''
    return true
  })

  const renderSection = (sectionId: SectionId): ReactNode => {
    const sectionRows = visibleRows.filter((r) => r.section === sectionId)
    if (sectionRows.length === 0) return null
    const label = t(SECTION_ORDER.find((s) => s.id === sectionId)!.labelKey)
    return (
      <section key={sectionId} className="mt-6 first:mt-2">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-label-md text-label-md font-medium uppercase tracking-wide text-on-surface-variant">
            {label}
          </h2>
          {sectionId === 'advanced' && (
            <div className="flex items-center gap-3">
              {!advancedOpen && (
                <span className="font-label-sm text-label-sm text-outline">
                  {t('settings.sectionAdvancedHint')}
                </span>
              )}
              <button
                onClick={handleResetTuning}
                className="rounded-md px-2 py-1 font-label-sm text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary"
              >
                {t('settings.resetDefaults')}
              </button>
              <button
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
                aria-label={label}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
              >
                <span
                  className={`material-symbols-outlined text-base transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                >
                  expand_more
                </span>
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3">{sectionRows.map((row, i) => renderRow(row, i))}</div>
      </section>
    )
  }

  const renderRow = (row: RowDef, index: number): ReactNode => (
    <SettingRow
      key={`${row.section}-${index}`}
      icon={row.icon}
      title={row.title}
      description={row.desc}
      extra={row.extra}
    >
      {row.control}
    </SettingRow>
  )

  const totalVisible = visibleRows.length

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">{t('settings.title')}</h1>
      </div>

      {/* 设置搜索：按标题/描述/分区过滤 */}
      <div className="sticky top-0 z-10 mt-4 flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2">
        <span className="material-symbols-outlined text-base text-on-surface-variant">search</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('settings.searchPlaceholder')}
          aria-label={t('settings.searchPlaceholder')}
          className="w-full bg-transparent font-body-md text-body-md text-on-surface outline-none placeholder:text-outline"
        />
        {search !== '' && (
          <button
            onClick={() => setSearch('')}
            aria-label={t('toast.close')}
            className="rounded-md p-1 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        )}
      </div>

      {totalVisible === 0 ? (
        <p className="mt-8 text-center font-body-md text-body-md text-on-surface-variant">
          {t('settings.searchEmpty')}
        </p>
      ) : (
        <div className="pb-4">{SECTION_ORDER.map((s) => renderSection(s.id))}</div>
      )}

      {proxyApplyTip && <Tooltip x={proxyApplyTip.x} y={proxyApplyTip.y} text={proxyApplyTip.text} />}
    </div>
  )
}
