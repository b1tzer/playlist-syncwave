import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { getSetting } from './settingsService'

export type NavView = 'create' | 'playlists' | 'sync' | 'accounts' | 'settings'

const isMac = process.platform === 'darwin'
const isDev = process.env.NODE_ENV === 'development'

type Lang = 'zh-CN' | 'en-US'

const LABELS: Record<
  Lang,
  {
    nav: string
    view: string
    create: string
    playlists: string
    sync: string
    accounts: string
    settings: string
    zoomIn: string
    zoomOut: string
    resetZoom: string
    fullscreen: string
    reload: string
    forceReload: string
    devTools: string
    quit: string
    updateCheck: string
  }
> = {
  'zh-CN': {
    nav: '导航',
    view: '视图',
    create: '快速创建歌单',
    playlists: '我的歌单',
    sync: '同步历史',
    accounts: '账号',
    settings: '设置',
    zoomIn: '放大',
    zoomOut: '缩小',
    resetZoom: '实际大小',
    fullscreen: '全屏',
    reload: '重新加载',
    forceReload: '强制重新加载',
    devTools: '开发者工具',
    quit: '退出',
    updateCheck: '检查更新',
  },
  'en-US': {
    nav: 'Navigation',
    view: 'View',
    create: 'Quick Create',
    playlists: 'My Playlists',
    sync: 'Sync History',
    accounts: 'Accounts',
    settings: 'Settings',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    resetZoom: 'Actual Size',
    fullscreen: 'Toggle Fullscreen',
    reload: 'Reload',
    forceReload: 'Force Reload',
    devTools: 'Toggle Developer Tools',
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
      { label: labels.create, accelerator: 'CmdOrCtrl+1', click: () => sendNavigate('create') },
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

  // 刷新与开发者工具只对开发调试有意义，正式包不注册对应加速器
  const devItems: MenuItemConstructorOptions[] = isDev
    ? [
        { type: 'separator' },
        { label: labels.reload, role: 'reload' },
        { label: labels.forceReload, role: 'forceReload' },
        { label: labels.devTools, role: 'toggleDevTools' },
      ]
    : []
  const viewMenu: MenuItemConstructorOptions = {
    label: labels.view,
    submenu: [
      { label: labels.zoomIn, role: 'zoomIn' },
      { label: labels.zoomOut, role: 'zoomOut' },
      { label: labels.resetZoom, role: 'resetZoom' },
      { type: 'separator' },
      { label: labels.fullscreen, role: 'togglefullscreen' },
      ...devItems,
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
    viewMenu,
    { role: 'windowMenu' },
    helpMenu,
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 窗口级快捷键：Cmd/Ctrl+, 打开设置、Cmd/Ctrl+N 快速创建；正式包吞掉刷新键 */
export function installWindowShortcuts(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = isMac ? input.meta : input.control
    const key = input.key.toLowerCase()
    if (!isDev && (input.key === 'F5' || (mod && !input.alt && key === 'r'))) {
      event.preventDefault()
      return
    }
    if (!mod || input.alt || input.shift) return
    if (key === ',') {
      event.preventDefault()
      win.webContents.send('app:navigate', 'settings')
    } else if (key === 'n') {
      event.preventDefault()
      win.webContents.send('app:navigate', 'create')
    }
  })
}
