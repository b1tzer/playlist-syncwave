import { useEffect, useState } from 'react'
import { createRendererLogger } from '../logging/rendererLogger'
import { LOCALES, useI18n } from '../i18n'
import ToggleSwitch from './ToggleSwitch'
import { notify } from './toast'
import type { UpdateStatus } from '../../../preload/index'

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
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [syncThreshold, setSyncThreshold] = useState(0.6)
  const [syncRetries, setSyncRetries] = useState(2)
  const [syncInterval, setSyncInterval] = useState(500)
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyDraft, setProxyDraft] = useState('')

  const handleProxyApply = async () => {
    try {
      await window.electronAPI.proxy.set(proxyDraft.trim())
      setProxyUrl(proxyDraft.trim())
      log.info('settings.proxy-apply', '代理已应用', { url: proxyDraft.trim() })
    } catch (e) {
      log.error('settings.proxy-apply-failed', '应用代理失败', e)
      notify('error', t('settings.proxyApplyFailed'), e instanceof Error ? e.message : '')
    }
  }

  const handleProxyClear = async () => {
    try {
      await window.electronAPI.proxy.set('')
      setProxyUrl('')
      setProxyDraft('')
      log.info('settings.proxy-clear', '代理已清除')
    } catch (e) {
      log.error('settings.proxy-clear-failed', '清除代理失败', e)
    }
  }

  // 自动更新状态流转
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

  // 从 SQLite 恢复设置；开机启动读取系统登录项真实状态
  useEffect(() => {
    window.electronAPI.settings
      .getAll()
      .then((all) => {
        setReportEnabled(all.reportEnabled === true)
        if (typeof all.syncThreshold === 'number') setSyncThreshold(all.syncThreshold)
        if (typeof all.syncRetries === 'number') setSyncRetries(all.syncRetries)
        if (typeof all.syncSearchInterval === 'number') setSyncInterval(all.syncSearchInterval)
        log.debug('settings.restored', '设置已恢复', { keys: Object.keys(all) })
      })
      .catch((e) => {
        log.warn('settings.restore-failed', '设置恢复失败', e)
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
      })
      .catch((e) => {
        log.warn('settings.proxy-read-failed', '读取代理设置失败', e)
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
              window.electronAPI
                .setAutoLaunch(next)
                .then(() => log.info('settings.auto-launch', '开机启动设置已应用', { enabled: next }))
                .catch((e) =>
                  log.error('settings.auto-launch', '开机启动设置失败', e, {
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
          icon="tune"
          title={t('settings.syncThreshold')}
          description={t('settings.syncThresholdDesc')}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.4}
              max={0.9}
              step={0.05}
              value={syncThreshold}
              onChange={(e) => {
                const v = Number(e.target.value)
                setSyncThreshold(v)
                window.electronAPI.settings.set('syncThreshold', v).catch(() => {})
              }}
              className="w-40 accent-primary"
            />
            <span className="w-10 text-right font-label-mono text-label-mono text-on-surface">
              {syncThreshold.toFixed(2)}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          icon="replay"
          title={t('settings.syncRetries')}
          description={t('settings.syncRetriesDesc')}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={5}
              step={1}
              value={syncRetries}
              onChange={(e) => {
                const v = Number(e.target.value)
                setSyncRetries(v)
                window.electronAPI.settings.set('syncRetries', v).catch(() => {})
              }}
              className="w-40 accent-primary"
            />
            <span className="w-10 text-right font-label-mono text-label-mono text-on-surface">
              {syncRetries}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          icon="speed"
          title={t('settings.syncInterval')}
          description={t('settings.syncIntervalDesc')}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={300}
              max={3000}
              step={100}
              value={syncInterval}
              onChange={(e) => {
                const v = Number(e.target.value)
                setSyncInterval(v)
                window.electronAPI.settings.set('syncSearchInterval', v).catch(() => {})
              }}
              className="w-40 accent-primary"
            />
            <span className="w-16 text-right font-label-mono text-label-mono text-on-surface">
              {t('settings.syncIntervalUnit', { value: syncInterval })}
            </span>
          </div>
        </SettingRow>
        <SettingRow
          icon="router"
          title={t('settings.proxy')}
          description={t('settings.proxyDesc')}
        >
          <div className="flex items-center gap-2">
            <input
              value={proxyDraft}
              onChange={(e) => setProxyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleProxyApply()
              }}
              placeholder={t('settings.proxyPlaceholder')}
              className="w-56 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary"
            />
            <button
              onClick={() => void handleProxyApply()}
              className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high hover:text-primary"
            >
              {t('settings.proxyApply')}
            </button>
            {proxyUrl !== '' && (
              <button
                onClick={() => void handleProxyClear()}
                title={t('settings.proxyClear')}
                className="flex items-center rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            )}
          </div>
        </SettingRow>
        <SettingRow
          icon="system_update"
          title={t('settings.update')}
          description={t('settings.updateDesc')}
        >
          <div className="flex items-center gap-3">
            {updateStatus?.state === 'downloaded' ? (
              <button
                onClick={() => {
                  log.info('settings.update-install', '重启并安装新版本')
                  window.electronAPI.updater.quitAndInstall().catch(() => {})
                }}
                className="rounded-lg bg-primary px-3 py-1.5 font-label-md text-label-md font-medium text-on-primary transition-colors hover:brightness-110"
              >
                {t('settings.updateRestart')}
              </button>
            ) : (
              <button
                onClick={() => {
                  log.info('settings.update-check', '手动检查更新')
                  setUpdateStatus({ state: 'checking' })
                  window.electronAPI.updater
                    .check()
                    .catch(() =>
                      setUpdateStatus({ state: 'error', message: t('settings.updateDevMode') }),
                    )
                }}
                className="rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-high"
              >
                {t('settings.updateCheck')}
              </button>
            )}
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {updateStatus?.state === 'checking' && t('settings.updateChecking')}
              {updateStatus?.state === 'not-available' && t('settings.updateLatest')}
              {updateStatus?.state === 'available' &&
                t('settings.updateAvailable', { version: updateStatus.version })}
              {updateStatus?.state === 'downloading' &&
                t('settings.updateDownloading', { percent: updateStatus.percent })}
              {updateStatus?.state === 'downloaded' &&
                t('settings.updateDownloaded')}
              {updateStatus?.state === 'error' && t('settings.updateFailed')}
            </span>
          </div>
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
