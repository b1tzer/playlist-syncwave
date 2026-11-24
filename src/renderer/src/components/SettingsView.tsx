import { useEffect, useState } from 'react'
import { createRendererLogger } from '../logging/rendererLogger'

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
      <div className="flex items-center gap-2 font-label-mono text-label-mono text-primary">
        <span className="material-symbols-outlined text-sm">settings_suggest</span>
        <span>PREFERENCES LOCAL ONLY</span>
      </div>
      <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">设置</h1>
      <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
        所有配置仅保存在本地，凭证经系统钥匙串加密
      </p>

      <div className="mt-6 flex max-w-2xl flex-col gap-3">
        <SettingRow icon="dark_mode" title="主题" description="深色（跟随 SyncWave 设计规范）">
          <span className="rounded-full bg-primary-container/15 px-3 py-1 font-label-sm text-label-sm text-primary">
            深色
          </span>
        </SettingRow>
        <SettingRow icon="language" title="语言" description="界面显示语言">
          <span className="rounded-full bg-surface-container-highest px-3 py-1 font-label-sm text-label-sm text-on-surface-variant">
            简体中文
          </span>
        </SettingRow>
        <SettingRow
          icon="power_settings_new"
          title="开机启动"
          description="登录系统后自动运行 SyncWave"
        >
          <button
            role="switch"
            aria-checked={autoLaunch}
            onClick={() => {
              setAutoLaunch((v) => {
                const next = !v
                window.electronAPI.settings.set('autoLaunch', next).catch(() => {})
                log.info('settings.auto-launch', '切换开机启动', { enabled: next })
                return next
              })
            }}
            className={`h-6 w-11 rounded-full p-0.5 transition-colors ${
              autoLaunch ? 'bg-primary' : 'bg-surface-container-highest'
            }`}
          >
            <span
              className={`block h-5 w-5 rounded-full bg-on-surface transition-transform ${
                autoLaunch ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </SettingRow>
        <SettingRow
          icon="shield_lock"
          title="隐私 · 日志上报"
          description="默认关闭，开启后脱敏日志才会发送"
        >
          <button
            role="switch"
            aria-checked={reportEnabled}
            onClick={() => {
              setReportEnabled((v) => {
                const next = !v
                window.electronAPI.settings.set('reportEnabled', next).catch(() => {})
                log.info('settings.log-report', '切换日志上报', { enabled: next })
                return next
              })
            }}
            className={`h-6 w-11 rounded-full p-0.5 transition-colors ${
              reportEnabled ? 'bg-primary' : 'bg-surface-container-highest'
            }`}
          >
            <span
              className={`block h-5 w-5 rounded-full bg-on-surface transition-transform ${
                reportEnabled ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </SettingRow>
        <SettingRow
          icon="info"
          title="关于"
          description="SyncWave v0.1.0 · 本地优先 · 跨平台歌单同步"
        >
          <span className="font-label-mono text-label-mono text-outline">
            Electron · React · Tailwind
          </span>
        </SettingRow>
      </div>
    </div>
  )
}
