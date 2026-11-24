import { useEffect, useState } from 'react'
import type { PlatformAccount } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/translations'

const log = createRendererLogger('renderer.nav')

export type View = 'create' | 'playlists' | 'sync' | 'accounts' | 'settings'

const NAV_ITEMS: Array<{ id: View; labelKey: TranslationKey; icon: string }> = [
  { id: 'create', labelKey: 'nav.create', icon: 'edit_note' },
  { id: 'playlists', labelKey: 'nav.playlists', icon: 'queue_music' },
  { id: 'sync', labelKey: 'nav.sync', icon: 'sync_alt' },
  { id: 'accounts', labelKey: 'nav.accounts', icon: 'switch_account' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings' },
]

interface SidebarProps {
  view: View
  onNavigate: (view: View) => void
  runningTasks: number
  accounts: Record<string, PlatformAccount | null>
}

export default function Sidebar({ view, onNavigate, runningTasks, accounts }: SidebarProps) {
  const { t } = useI18n()
  const [version, setVersion] = useState('')
  const loggedInCount = Object.values(accounts).filter((a) => a !== null).length
  const isMac = window.electronAPI.platform === 'darwin'

  useEffect(() => {
    window.electronAPI
      .getVersion()
      .then(setVersion)
      .catch(() => log.debug('nav.version', '查询应用版本失败'))
  }, [])

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-outline-variant bg-surface-container-lowest px-3 py-4">
      {/* macOS 隐藏标题栏后为红绿灯留白，同时作为窗口拖拽区 */}
      {isMac && <div className="h-9 shrink-0 [-webkit-app-region:drag]" />}
      <div className="flex items-center gap-2 px-2">
        <span className="material-symbols-outlined text-lg text-primary">graphic_eq</span>
        <div>
          <p className="font-label-md text-label-md font-semibold leading-tight text-on-surface">
            {t('app.title')}
          </p>
          {version && (
            <p className="font-label-sm text-label-sm text-on-surface-variant">
              {t('sidebar.version', { version })}
            </p>
          )}
        </div>
      </div>

      <nav className="mt-6 flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = view === item.id
          return (
            <button
              key={item.id}
              onClick={() => {
                log.info('nav.click', '侧边栏切换视图', { view: item.id })
                onNavigate(item.id)
              }}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                active
                  ? 'bg-primary-container/15 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <span className={`material-symbols-outlined text-xl ${active ? 'fill' : ''}`}>
                {item.icon}
              </span>
              <span className="font-label-md text-label-md flex-1">{t(item.labelKey)}</span>
              {item.id === 'sync' && runningTasks > 0 && (
                <span className="rounded-full bg-primary px-1.5 py-0.5 font-label-sm text-label-sm font-medium text-on-primary">
                  {runningTasks}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2">
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-base text-tertiary">headphones</span>
            <p className="font-label-sm text-label-sm text-on-surface">{t('sidebar.statusTitle')}</p>
          </div>
          <div className="mt-2 flex items-center gap-2 font-label-mono text-label-mono text-outline">
            <span className="material-symbols-outlined text-sm">dark_mode</span>
            <span>
              {t('sidebar.platformsOnline', {
                count: loggedInCount,
                total: Object.keys(accounts).length,
              })}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 font-label-mono text-label-mono text-outline">
            <span className="material-symbols-outlined text-sm">terminal</span>
            <span>{t('sidebar.engine')}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
