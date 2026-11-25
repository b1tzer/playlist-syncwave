import { describe, it, expect } from 'vitest'
import type { PlatformMeta } from '../../src/core/models/platform'
import { operationAllowed, operationReason } from '../../src/renderer/src/utils/platformCapabilities'

const meta = (capabilities: PlatformMeta['capabilities']): PlatformMeta => ({
  id: 'test',
  name: 'Test',
  icon: 'music_note',
  capabilities,
})

describe('platformCapabilities — 操作级能力清单查询', () => {
  it('write 为 false 时所有操作均不允许', () => {
    const m = meta({ read: true, write: false })
    expect(operationAllowed(m, 'createPlaylist')).toBe(false)
    expect(operationAllowed(m, 'removeSongs')).toBe(false)
  })

  it('write 为 true 且无操作级声明时全部允许', () => {
    const m = meta({ read: true, write: true })
    expect(operationAllowed(m, 'removeSongs')).toBe(true)
    expect(operationAllowed(m, 'renamePlaylist')).toBe(true)
    expect(operationReason(m, 'removeSongs')).toBeUndefined()
  })

  it('操作级声明不支持时仅该操作不允许，并返回原因', () => {
    const m = meta({
      read: true,
      write: true,
      unsupportedOperations: {
        removeSongs: { reason: '官方接口暂不支持移除歌曲' },
      },
    })
    expect(operationAllowed(m, 'removeSongs')).toBe(false)
    expect(operationReason(m, 'removeSongs')).toBe('官方接口暂不支持移除歌曲')
    expect(operationAllowed(m, 'addSongs')).toBe(true)
    expect(operationAllowed(m, 'deletePlaylist')).toBe(true)
  })

  it('meta 缺失时不允许且无原因', () => {
    expect(operationAllowed(undefined, 'removeSongs')).toBe(false)
    expect(operationReason(undefined, 'removeSongs')).toBeUndefined()
  })
})
