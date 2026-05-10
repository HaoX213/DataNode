import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import { getDefaultNotebookId, insertAssetItem, insertDocumentItem, insertExcelRows } from './db'

export type ImportResult = {
  success: boolean
  message: string
  inserted: number
}

const READ_IMPORT_FILE_MESSAGE =
  '读取文件失败，请检查该文件是否正在被 Excel 等其他软件打开，或确认当前账号有权限访问该文件；也可以尝试将其移动到其他目录后重试。'

function formatReadImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/cannot access file|cannot save file|EACCES|EPERM|EBUSY|ENOENT|permission|busy|locked|no such file|used by another process/i.test(message)) {
    return READ_IMPORT_FILE_MESSAGE
  }
  return `导入失败：${message}`
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isValidHeaderCell(value: string): boolean {
  if (!value) return false
  const upper = value.toUpperCase()
  return !upper.startsWith('__EMPTY')
}

export async function importExcelFile(filePath: string, projectId: number): Promise<ImportResult> {
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.readFile(filePath, { cellDates: true })
  } catch (error) {
    return { success: false, message: formatReadImportError(error), inserted: 0 }
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
    return { success: false, message: formatReadImportError(error), inserted: 0 }
  }

  if (matrix.length === 0) {
    return { success: false, message: 'Excel 为空，未导入数据', inserted: 0 }
  }

  // 智能寻找表头：选择首个“有效列名数量 >= 2”的行作为表头
  let headerRowIndex = -1
  let headers: string[] = []
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] ?? []
    const rowHeaders = row.map((cell, colIndex) => {
      const normalized = normalizeCell(cell)
      return isValidHeaderCell(normalized) ? normalized : `column_${colIndex + 1}`
    })
    const validHeaderCount = row.map((cell) => normalizeCell(cell)).filter(isValidHeaderCell).length
    if (validHeaderCount >= 2) {
      headerRowIndex = rowIndex
      headers = rowHeaders
      break
    }
  }

  if (headerRowIndex === -1) {
    return { success: false, message: '未识别到有效表头（至少需要2个有效列名）', inserted: 0 }
  }

  const notebookId = getDefaultNotebookId()
  const payload: {
    notebookId: number
    projectId: number
    sourceFilePath: string
    sourceRowIndex: number
    contentText: string
    contentJson: string
  }[] = []

  for (let i = headerRowIndex + 1; i < matrix.length; i += 1) {
    const row = matrix[i] ?? []
    const rowObject: Record<string, string> = {}

    headers.forEach((key, colIndex) => {
      if (!isValidHeaderCell(key)) return
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

  try {
    const inserted = insertExcelRows(payload)
    return {
      success: true,
      message: `Excel 导入完成：${path.basename(filePath)}，共写入 ${inserted} 行`,
      inserted
    }
  } catch (error) {
    return { success: false, message: formatReadImportError(error), inserted: 0 }
  }
}

export async function importDocxFile(filePath: string, projectId: number): Promise<ImportResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch (error) {
    return { success: false, message: formatReadImportError(error), inserted: 0 }
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
    await copyFile(filePath, storedPath)

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
    return { success: false, message: formatReadImportError(error), inserted: 0 }
  }

  return {
    success: true,
    message: `资产导入完成：${path.basename(filePath)}`,
    inserted: 1
  }
}
