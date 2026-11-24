import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logCenter } from './logging/logCenter'

const log = logCenter.logger('window-state')

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { width: 1200, height: 820, maximized: false }

function filePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 校验保存的窗口位置是否仍与某个显示器可见区域相交（显示器配置变化后可能越界） */
function isVisibleOnSomeDisplay(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return true
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      state.x! < area.x + area.width &&
      state.x! + state.width > area.x &&
      state.y! < area.y + area.height &&
      state.y! + state.height > area.y
    )
  })
}

export function loadWindowState(): WindowState {
  try {
    if (!existsSync(filePath())) return DEFAULT_STATE
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8')) as Partial<WindowState>
    const state: WindowState = {
      width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_STATE.width,
      height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_STATE.height,
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      maximized: parsed.maximized === true,
    }
    return isVisibleOnSomeDisplay(state) ? state : { ...state, x: undefined, y: undefined }
  } catch (e) {
    log.error('window-state.load', '读取窗口状态失败，回退默认', e)
    return DEFAULT_STATE
  }
}

let saveTimer: NodeJS.Timeout | null = null

/** 追踪窗口状态：resize/move 防抖保存，close 立即保存 */
export function trackWindowState(win: BrowserWindow): void {
  const persist = () => {
    if (win.isDestroyed() || win.isMinimized()) return
    const bounds = win.getNormalBounds()
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    }
    try {
      writeFileSync(filePath(), JSON.stringify(state), 'utf-8')
    } catch (e) {
      log.error('window-state.save', '保存窗口状态失败', e)
    }
  }
  const debouncedPersist = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persist, 500)
  }
  win.on('resize', debouncedPersist)
  win.on('move', debouncedPersist)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    persist()
  })
}
