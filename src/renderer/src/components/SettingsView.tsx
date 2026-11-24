import { useEffect, useState } from 'react'
import { createRendererLogger } from '../logging/rendererLogger'
import { LOCALES, useI18n } from '../i18n'
import ToggleSwitch from './ToggleSwitch'

const log = createRendererLogger('renderer.settings')

interface SettingRowProps {
  icon: string
  title: string
  description: string
  children?: React.ReactNode
}

function SettingRow({ icon, title, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-xl text-on-surface-variant">{icon}</span>
        <div>
          <p className="font-body-md text-body-md font-medium">{title}</p>
          <p className="font-label-sm text-label-sm text-on-surface-variant">{description}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

export default function SettingsView() {
  const { t, locale, setLocale } = useI18n()
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [reportEnabled, setReportEnabled] = useState(false)

  // 从 SQLite 恢复设置
  useEffect(() => {
    window.electronAPI.settings
      .getAll()
      .then((all) => {
        setAutoLaunch(all.autoLaunch === true)
        setReportEnabled(all.reportEnabled === true)
        log.debug('settings.restored', '设置已恢复', { keys: Object.keys(all) })
      })
      .catch((e) => {
        log.warn('settings.restore-failed', '设置恢复失败', e)
      })
  }, [])

  return (
    <div>
      <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">
        {t('settings.title')}
      </h1>

      <div className="mt-6 flex flex-col gap-3">
        <SettingRow
          icon="dark_mode"
          title={t('settings.theme')}
          description={t('settings.themeDesc')}
        >
          <span className="rounded-full bg-primary-container/15 px-3 py-1 font-label-sm text-label-sm text-primary">
            {t('settings.dark')}
          </span>
        </SettingRow>
        <SettingRow
          icon="language"
          title={t('settings.language')}
          description={t('settings.languageDesc')}
        >
          <div className="flex gap-1 rounded-lg border border-outline-variant bg-surface-container-highest p-1">
            {LOCALES.map((l) => (
              <button
                key={l}
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
        </SettingRow>
        <SettingRow
          icon="power_settings_new"
          title={t('settings.autoLaunch')}
          description={t('settings.autoLaunchDesc')}
        >
          <ToggleSwitch
            checked={autoLaunch}
            onChange={(next) => {
              setAutoLaunch(next)
              window.electronAPI.settings
                .set('autoLaunch', next)
                .then(() => log.info('settings.auto-launch', '开机启动设置已保存', { enabled: next }))
                .catch((e) =>
                  log.error('settings.auto-launch', '开机启动设置保存失败', e, {
                    enabled: next,
                  }),
                )
            }}
          />
        </SettingRow>
        <SettingRow
          icon="shield_lock"
          title={t('settings.logReport')}
          description={t('settings.logReportDesc')}
        >
          <ToggleSwitch
            checked={reportEnabled}
            onChange={(next) => {
              setReportEnabled(next)
              window.electronAPI.settings
                .set('reportEnabled', next)
                .then(() => log.info('settings.log-report', '日志上报设置已保存', { enabled: next }))
                .catch((e) =>
                  log.error('settings.log-report', '日志上报设置保存失败', e, {
                    enabled: next,
                  }),
                )
            }}
          />
        </SettingRow>
        <SettingRow
          icon="info"
          title={t('settings.about')}
          description={t('settings.aboutDesc')}
        >
          <span className="font-label-mono text-label-mono text-outline">
            Electron · React · Tailwind
          </span>
        </SettingRow>
      </div>
    </div>
  )
}
