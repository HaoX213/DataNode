import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function getLogsDirectory(): string {
  return join(app.getPath('userData'), 'logs')
}

export function getLogFilePath(): string {
  return join(getLogsDirectory(), 'datanode.log')
}

export function appendLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  try {
    const logsDir = getLogsDirectory()
    mkdirSync(logsDir, { recursive: true })
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
    appendFileSync(getLogFilePath(), line, { encoding: 'utf8' })
  } catch {
    // 避免日志写入失败拖垮主进程
  }
}
