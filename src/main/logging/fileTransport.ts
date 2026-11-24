import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { formatJsonLine } from '@core/logging'
import type { LogEntry, LogTransport } from '@core/logging'

const MB = 1024 * 1024
const DEFAULT_MAX_BYTES = 5 * MB
const DEFAULT_KEEP_DAYS = 7
const MAX_ROTATED_FILES = 3

function localDate(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fileAgeDays(file: string): number {
  const mtimeMs = statSync(file).mtimeMs
  return (Date.now() - mtimeMs) / (24 * 60 * 60 * 1000)
}

/**
 * 主进程文件日志传输：
 * - 按天分文件（app-YYYY-MM-DD.log），跨平台使用 path.join 与系统 userData 目录
 * - 单文件超过上限自动轮转（.1/.2/.3）
 * - 启动时清理超过保留天数的旧日志
 * - 同步追加写，崩溃不丢日志；日志量级小，性能可接受
 */
export class FileLogTransport implements LogTransport {
  readonly name = 'file'
  private currentFile = ''
  private currentDate = ''

  constructor(
    private readonly dir: string,
    private readonly options: {
      maxBytes?: number
      keepDays?: number
      prefix?: string
    } = {},
  ) {}

  get maxBytes(): number {
    return this.options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  get keepDays(): number {
    return this.options.keepDays ?? DEFAULT_KEEP_DAYS
  }

  get prefix(): string {
    return this.options.prefix ?? 'app'
  }

  /** 初始化目录并清理过期日志 */
  init(): void {
    mkdirSync(this.dir, { recursive: true })
    this.cleanup()
  }

  write(entry: LogEntry): void {
    try {
      this.rotateIfNeeded()
      appendFileSync(this.currentFile, `${formatJsonLine(entry)}\n`, 'utf-8')
    } catch {
      // 磁盘异常时静默，避免日志写入拖垮业务
    }
  }

  private targetFile(date: string): string {
    return join(this.dir, `${this.prefix}-${date}.log`)
  }

  private rotateIfNeeded(): void {
    const date = localDate()
    if (this.currentDate !== date) {
      this.currentDate = date
      this.currentFile = this.targetFile(date)
      return
    }

    if (!existsSync(this.currentFile)) return
    if (statSync(this.currentFile).size < this.maxBytes) return

    for (let i = MAX_ROTATED_FILES; i >= 1; i--) {
      const src = i === 1 ? this.currentFile : `${this.currentFile}.${i - 1}`
      const dst = `${this.currentFile}.${i}`
      if (i === MAX_ROTATED_FILES && existsSync(dst)) unlinkSync(dst)
      if (existsSync(src)) renameSync(src, dst)
    }
  }

  private cleanup(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return
    }
    const pattern = new RegExp(`^${this.prefix}-\\d{4}-\\d{2}-\\d{2}\\.log(\\.\\d+)?$`)
    for (const file of files) {
      if (!pattern.test(file)) continue
      const full = join(this.dir, file)
      try {
        if (fileAgeDays(full) > this.keepDays) unlinkSync(full)
      } catch {
        // 单个文件清理失败不影响整体
      }
    }
  }
}
