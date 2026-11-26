import { describe, expect, it } from 'vitest'
import { findInstallerAsset, releaseAssetUrl } from '../../src/main/updateAsset'

const files = [
  { url: 'SyncWave-0.1.1-arm64-mac.zip', sha512: 'a' },
  { url: 'SyncWave-0.1.1.dmg', sha512: 'b' },
  { url: 'SyncWave-Setup-0.1.1.exe', sha512: 'c' },
  { url: 'SyncWave-0.1.1.AppImage', sha512: 'd' },
]

describe('updateAsset', () => {
  it('picks the macOS DMG asset', () => {
    expect(findInstallerAsset(files, 'darwin')?.url).toBe('SyncWave-0.1.1.dmg')
  })

  it('picks the Windows NSIS installer', () => {
    expect(findInstallerAsset(files, 'win32')?.url).toBe('SyncWave-Setup-0.1.1.exe')
  })

  it('picks the Linux AppImage', () => {
    expect(findInstallerAsset(files, 'linux')?.url).toBe('SyncWave-0.1.1.AppImage')
  })

  it('returns undefined when metadata has no matching installer', () => {
    expect(findInstallerAsset(undefined, 'darwin')).toBeUndefined()
    expect(findInstallerAsset([{ url: 'latest.yml' }], 'win32')).toBeUndefined()
  })

  it('builds a version-pinned release asset URL', () => {
    expect(releaseAssetUrl('0.1.1', 'SyncWave-0.1.1.dmg')).toBe(
      'https://github.com/b1tzer/playlist-syncwave/releases/download/v0.1.1/SyncWave-0.1.1.dmg',
    )
  })
})
