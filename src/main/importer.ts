import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import { appendLog } from './app-log'
import { getDefaultNotebookId, insertAssetItem, insertDocumentItem, insertExcelRows, insertStructuredJsonRows } from './db'

export type ImportResult = {
  success: boolean
  message: string
  inserted: number
  /** 纯文本等：交给 AI 解析，不写库 */
  mode?: 'ai_text'
  preview?: string
  filePath?: string
}

const READ_IMPORT_FILE_MESSAGE =
  '读取文件失败，请检查该文件是否正在被 Excel 等其他软件打开，或确认当前账号有权限访问该文件；也可以尝试将其移动到其他目录后重试。'

function formatReadImportError(error: unknown, logContext?: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code ?? '')
      : ''
  if (logContext) {
    appendLog('ERROR', `${logContext}${code ? ` [${code}]` : ''} — ${message}`)
  }
  if (/cannot access file|cannot save file|EACCES|EPERM|EBUSY|ENOENT|permission|busy|locked|no such file|used by another process/i.test(message)) {
    return READ_IMPORT_FILE_MESSAGE
  }
  return `导入失败：${message}`
}

function readExcelWorkbook(buffer: Buffer): XLSX.WorkBook {
  try {
    return XLSX.read(buffer, { type: 'buffer', cellDates: true })
  } catch (first) {
    // 少数旧版 .xls / 编码场景下 buffer 模式失败，回退为 binary 字符串解析
    try {
      return XLSX.read(buffer.toString('binary'), { type: 'binary', cellDates: true })
    } catch {
      throw first
    }
  }
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 1
        } else {
          inQ = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQ = true
    } else if (c === ',') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur.trim())
  return out
}

export async function importCsvFile(filePath: string, projectId: number): Promise<ImportResult> {
  let text: string
  try {
    const buf = await readFile(path.resolve(filePath))
    text = buf.toString('utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `CSV 读取失败: ${filePath}`),
      inserted: 0
    }
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) {
    return { success: false, message: 'CSV 至少需要表头一行与一行数据', inserted: 0 }
  }

  const headers = parseCsvLine(lines[0]!).map((h, idx) => normalizeCell(h) || `column_${idx + 1}`)
  const notebookId = getDefaultNotebookId()
  const payload: {
    notebookId: number
    projectId: number
    sourceFilePath: string
    sourceRowIndex: number
    contentText: string
    contentJson: string
  }[] = []

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]!)
    const rowObject: Record<string, string> = {}
    headers.forEach((key, colIndex) => {
      rowObject[key] = normalizeCell(cells[colIndex] ?? '')
    })
    const contentText = Object.values(rowObject).join(' ').trim()
    if (!contentText) continue
    payload.push({
      notebookId,
      projectId,
      sourceFilePath: filePath,
      sourceRowIndex: i + 1,
      contentText,
      contentJson: JSON.stringify(rowObject)
    })
  }

  if (payload.length === 0) {
    return { success: false, message: 'CSV 无有效数据行', inserted: 0 }
  }

  try {
    const inserted = insertExcelRows(payload)
    return {
      success: true,
      message: `CSV 导入完成：${path.basename(filePath)}，共写入 ${inserted} 行`,
      inserted
    }
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `CSV 写入数据库失败: ${filePath}`),
      inserted: 0
    }
  }
}

export async function importJsonTableFile(filePath: string, projectId: number): Promise<ImportResult> {
  let raw: string
  try {
    raw = (await readFile(path.resolve(filePath))).toString('utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `JSON 读取失败: ${filePath}`),
      inserted: 0
    }
  }

  let data: unknown
  try {
    data = JSON.parse(raw) as unknown
  } catch {
    return { success: false, message: 'JSON 格式无效，无法用 AI 以外的方式自动导入', inserted: 0 }
  }

  let objects: Record<string, unknown>[] = []
  if (Array.isArray(data)) {
    objects = data.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x))
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    objects = [data as Record<string, unknown>]
  } else {
    return { success: false, message: 'JSON 须为对象数组或单对象，以便转为表格行', inserted: 0 }
  }

  if (objects.length === 0) {
    return { success: false, message: 'JSON 数组为空', inserted: 0 }
  }

  const n = insertStructuredJsonRows({
    projectId,
    sourceFilePath: filePath,
    rows: objects
  })

  return {
    success: true,
    message: `JSON 导入完成：${path.basename(filePath)}，共写入 ${n} 行`,
    inserted: n
  }
}

export async function readTextFilePreview(filePath: string, maxChars: number): Promise<{ text: string }> {
  const buf = await readFile(path.resolve(filePath))
  const text = buf.toString('utf8').replace(/^\uFEFF/, '')
  return { text: text.length > maxChars ? text.slice(0, maxChars) : text }
}

export async function importExcelFile(filePath: string, projectId: number): Promise<ImportResult> {
  let workbook: XLSX.WorkBook
  try {
    // SheetJS 的 readFile 在部分 Windows/Electron 环境下会误报 “Cannot access file”；
    // 先用 Node 读入 Buffer 再 parse，与权限检测及 docx 路径一致。
    const resolvedPath = path.resolve(filePath)
    const buffer = await readFile(resolvedPath)
    workbook = readExcelWorkbook(buffer)
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `Excel 读取失败: ${filePath}`),
      inserted: 0
    }
  }

  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) {
    return { success: false, message: 'Excel 中未找到可读取工作表', inserted: 0 }
  }

  const sheet = workbook.Sheets[firstSheetName]
  let matrix: (string | number | Date | null)[][]
  try {
    matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: ''
    })
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `Excel 解析工作表失败: ${filePath}`),
      inserted: 0
    }
  }

  if (matrix.length < 2) {
    return { success: false, message: 'Excel 至少需要表头一行与一行数据', inserted: 0 }
  }

  // 第一行固定为表头（字段名）
  const headerRow = matrix[0] ?? []
  const headers = headerRow.map((cell, colIndex) => {
    const normalized = normalizeCell(cell)
    return normalized || `column_${colIndex + 1}`
  })

  const notebookId = getDefaultNotebookId()
  const payload: {
    notebookId: number
    projectId: number
    sourceFilePath: string
    sourceRowIndex: number
    contentText: string
    contentJson: string
  }[] = []

  for (let i = 1; i < matrix.length; i += 1) {
    const row = matrix[i] ?? []
    const rowObject: Record<string, string> = {}

    headers.forEach((key, colIndex) => {
      rowObject[key] = normalizeCell(row[colIndex])
    })

    const contentText = Object.values(rowObject).join(' ').trim()
    if (!contentText) continue

    payload.push({
      notebookId,
      projectId,
      sourceFilePath: filePath,
      sourceRowIndex: i + 1,
      contentText,
      contentJson: JSON.stringify(rowObject)
    })
  }

  if (payload.length === 0) {
    return { success: false, message: 'Excel 无有效数据行（表头以下均为空）', inserted: 0 }
  }

  try {
    const inserted = insertExcelRows(payload)
    return {
      success: true,
      message: `Excel 导入完成：${path.basename(filePath)}，共写入 ${inserted} 行`,
      inserted
    }
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `Excel 写入数据库失败: ${filePath}`),
      inserted: 0
    }
  }
}

export async function importDocxFile(filePath: string, projectId: number): Promise<ImportResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(path.resolve(filePath))
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `Word 读取失败: ${filePath}`),
      inserted: 0
    }
  }

  const result = await mammoth.extractRawText({ buffer })
  const text = result.value.trim()
  if (!text) {
    return { success: false, message: 'Word 文档未提取到有效文本', inserted: 0 }
  }

  const notebookId = getDefaultNotebookId()
  try {
    insertDocumentItem({
      notebookId,
      projectId,
      sourceFilePath: filePath,
      contentText: text
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `导入失败：${message}`, inserted: 0 }
  }

  return {
    success: true,
    message: `Word 导入完成：${path.basename(filePath)}，共写入 1 条`,
    inserted: 1
  }
}

function safeFileName(filePath: string): string {
  const parsed = path.parse(filePath)
  const base = parsed.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'asset'
  return `${base}-${Date.now()}${parsed.ext}`
}

export async function importAssetFile(filePath: string, title: string, projectId: number): Promise<ImportResult> {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    return { success: false, message: '资产文件必须填写标题/摘要', inserted: 0 }
  }

  const assetsDir = path.join(app.getPath('userData'), 'assets')
  try {
    await mkdir(assetsDir, { recursive: true })
    const storedPath = path.join(assetsDir, safeFileName(filePath))
    await copyFile(path.resolve(filePath), storedPath)

    const notebookId = getDefaultNotebookId()
    insertAssetItem({
      notebookId,
      projectId,
      title: normalizedTitle,
      sourceFilePath: storedPath,
      originalFilePath: filePath,
      extension: path.extname(filePath).toLowerCase()
    })
  } catch (error) {
    return {
      success: false,
      message: formatReadImportError(error, `资产文件复制失败: ${filePath}`),
      inserted: 0
    }
  }

  return {
    success: true,
    message: `资产导入完成：${path.basename(filePath)}`,
    inserted: 1
  }
}
