import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logCenter } from './logging/logCenter'

const log = logCenter.logger('credential')

interface CredentialFile {
  [platform: string]: string
}

const cache = new Map<string, string>()

function filePath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

function load(): CredentialFile {
  try {
    if (!existsSync(filePath())) return {}
    const raw = readFileSync(filePath(), 'utf-8')
    return JSON.parse(raw) as CredentialFile
  } catch (e) {
    log.error('credential.load', '读取凭证文件失败', e)
    return {}
  }
}

export function getCredential(platform: string): string | null {
  if (cache.has(platform)) return cache.get(platform)!
  const encrypted = load()[platform]
  if (!encrypted) {
    log.debug('credential.get', '无已保存凭证', { platform })
    return null
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('credential.get', '系统加密不可用，无法解密凭证', { platform })
    return null
  }
  try {
    const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    cache.set(platform, plain)
    log.debug('credential.get', '凭证解密成功', { platform })
    return plain
  } catch (e) {
    log.error('credential.decrypt', '凭证解密失败', e, { platform })
    return null
  }
}

export function setCredential(platform: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法保存凭证')
  }
  const file = load()
  file[platform] = safeStorage.encryptString(value).toString('base64')
  mkdirSync(join(filePath(), '..'), { recursive: true })
  writeFileSync(filePath(), JSON.stringify(file), 'utf-8')
  cache.set(platform, value)
  log.info('credential.save', '凭证已加密保存', { platform, length: value.length })
}

export function clearCredential(platform: string): void {
  const file = load()
  delete file[platform]
  writeFileSync(filePath(), JSON.stringify(file), 'utf-8')
  cache.delete(platform)
  log.info('credential.clear', '凭证已清除', { platform })
}
