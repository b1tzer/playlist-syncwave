import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { getSetting } from './settingsService'

export type NavView = 'create' | 'playlists' | 'sync' | 'accounts' | 'settings'

const isMac = process.platform === 'darwin'

type Lang = 'zh-CN' | 'en-US'

const LABELS: Record<
  Lang,
  {
    nav: string
    create: string
    playlists: string
    sync: string
    accounts: string
    settings: string
    quit: string
    updateCheck: string
  }
> = {
  'zh-CN': {
    nav: '视图',
    create: '快速创建歌单',
    playlists: '我的歌单',
    sync: '同步历史',
    accounts: '账号',
    settings: '设置',
    quit: '退出',
    updateCheck: '检查更新',
  },
  'en-US': {
    nav: 'View',
    create: 'Quick Create',
    playlists: 'My Playlists',
    sync: 'Sync History',
    accounts: 'Accounts',
    settings: 'Settings',
    quit: 'Quit',
    updateCheck: 'Check for Updates',
  },
}

function currentLanguage(): Lang {
  return getSetting<string>('language', 'zh-CN') === 'en-US' ? 'en-US' : 'zh-CN'
}

function sendNavigate(view: NavView): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('app:navigate', view)
}

/** 构建并安装应用菜单：mac 含标准 App/Edit/View/Window 菜单（Edit 菜单保证剪贴板快捷键） */
export function buildApplicationMenu(): void {
  const labels = LABELS[currentLanguage()]

  const navMenu: MenuItemConstructorOptions = {
    label: labels.nav,
    submenu: [
      { label: labels.create, accelerator: 'CmdOrCtrl+N', click: () => sendNavigate('create') },
      { type: 'separator' },
      { label: labels.playlists, accelerator: 'CmdOrCtrl+2', click: () => sendNavigate('playlists') },
      { label: labels.sync, accelerator: 'CmdOrCtrl+3', click: () => sendNavigate('sync') },
      { label: labels.accounts, accelerator: 'CmdOrCtrl+4', click: () => sendNavigate('accounts') },
      { label: labels.settings, accelerator: 'CmdOrCtrl+5', click: () => sendNavigate('settings') },
      ...(isMac
        ? []
        : ([{ type: 'separator' }, { label: labels.quit, role: 'quit' }] as MenuItemConstructorOptions[])),
    ],
  }

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: labels.updateCheck,
        click: () => {
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
          win?.webContents.send('app:navigate', 'settings')
          win?.webContents.send('update:check-requested')
        },
      },
    ],
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    navMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    helpMenu,
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
