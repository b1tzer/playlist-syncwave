import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
  } catch {
    return {}
  }
}

export function getCredential(platform: string): string | null {
  if (cache.has(platform)) return cache.get(platform)!
  const encrypted = load()[platform]
  if (!encrypted) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  cache.set(platform, plain)
  return plain
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
}

export function clearCredential(platform: string): void {
  const file = load()
  delete file[platform]
  writeFileSync(filePath(), JSON.stringify(file), 'utf-8')
  cache.delete(platform)
}
