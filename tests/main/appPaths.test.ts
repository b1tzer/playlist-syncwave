import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  defaultUserData: '',
  isPackaged: false,
  calls: [] as Array<{ name: string; path: string }>,
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged
    },
    getPath: (_name: string) => state.defaultUserData,
    setPath: (name: string, path: string) => {
      state.calls.push({ name, path })
    },
  },
}))

async function loadAppPaths(): Promise<void> {
  vi.resetModules()
  await import('../../src/main/appPaths')
}

beforeEach(() => {
  state.defaultUserData = join(tmpdir(), 'playlist-default')
  state.isPackaged = false
  state.calls = []
  vi.stubEnv('PLAYLIST_USER_DATA_DIR', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('appPaths — 开发/生产数据目录隔离', () => {
  it('开发版把 userData 切到 userData/dev', async () => {
    await loadAppPaths()
    expect(state.calls).toEqual([{ name: 'userData', path: join(state.defaultUserData, 'dev') }])
  })

  it('正式版保持默认 userData，不调用 setPath', async () => {
    state.isPackaged = true
    await loadAppPaths()
    expect(state.calls).toEqual([])
  })

  it('环境变量绝对路径覆盖，且优先于 isPackaged', async () => {
    state.isPackaged = true
    vi.stubEnv('PLAYLIST_USER_DATA_DIR', join(tmpdir(), 'playlist-custom'))
    await loadAppPaths()
    expect(state.calls).toEqual([
      { name: 'userData', path: join(tmpdir(), 'playlist-custom') },
    ])
  })

  it('环境变量相对路径解析为绝对路径', async () => {
    vi.stubEnv('PLAYLIST_USER_DATA_DIR', './playlist-custom')
    await loadAppPaths()
    expect(state.calls).toEqual([{ name: 'userData', path: resolve('./playlist-custom') }])
  })
})
