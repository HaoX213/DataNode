import Database from 'better-sqlite3'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'

let db: Database.Database | null = null
let initialized = false

export function setStoragePath(storagePath: string): void {
  const trimmedPath = storagePath.trim()
  if (!trimmedPath) {
    throw new Error('存储路径不能为空')
  }
  const normalizedPath = resolve(trimmedPath)
  if (db) {
    if (resolve(app.getPath('userData')) === normalizedPath) return
    throw new Error('数据库已经初始化，无法切换存储路径')
  }
  mkdirSync(normalizedPath, { recursive: true })
  app.setPath('userData', normalizedPath)
}

function getDb(): Database.Database {
  if (!db) {
    const dbPath = join(app.getPath('userData'), 'datanode.db')
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
  }
  return db
}

function createItemsTableSql(tableName = 'items'): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      notebook_id         INTEGER NOT NULL,
      project_id          INTEGER,
      type                TEXT NOT NULL CHECK (type IN ('note','excel_row','document','file')),
      title               TEXT DEFAULT '',
      source_file_path    TEXT DEFAULT '',
      source_file_hash    TEXT DEFAULT '',
      source_row_index    INTEGER,
      content_text        TEXT NOT NULL DEFAULT '',
      content_json        TEXT DEFAULT '',
      tags                TEXT DEFAULT '[]',
      ai_embedding        BLOB,
      ai_model            TEXT DEFAULT '',
      ai_embedded_at      TEXT,
      x                   REAL,
      y                   REAL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at          TEXT GENERATED ALWAYS AS (datetime(created_at, '+3 years')) VIRTUAL,
      FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `
}

function ensureProjects(database: Database.Database): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  let row = database.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined
  if (!row) {
    const result = database.prepare("INSERT INTO projects (name) VALUES ('默认项目 (Default Project)')").run()
    row = { id: Number(result.lastInsertRowid) }
  }
  return row.id
}

function ensureItemsProjectColumn(database: Database.Database, defaultProjectId: number): void {
  const columns = database.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>
  const columnNames = new Set(columns.map((column) => column.name))
  if (!columnNames.has('project_id')) {
    database.exec('ALTER TABLE items ADD COLUMN project_id INTEGER;')
    /** 仅在首次添加列时回填，避免每次启动把书柜全局条目（project_id IS NULL）误写入默认项目 */
    database.prepare('UPDATE items SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId)
  }
}

function ensureItemPositionColumns(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>
  const columnNames = new Set(columns.map((column) => column.name))
  if (!columnNames.has('x')) {
    database.exec('ALTER TABLE items ADD COLUMN x REAL;')
  }
  if (!columnNames.has('y')) {
    database.exec('ALTER TABLE items ADD COLUMN y REAL;')
  }
}

const BOOKSHELF_PATH_REPAIR_KEY = 'v16_bookshelf_path_isolation'

/** 历史版本误将书柜文件（路径含 bookshelf-files）写上 project_id；一次性纠正为书柜全局 */
function runV16BookshelfPathRepair(database: Database.Database): void {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(BOOKSHELF_PATH_REPAIR_KEY) as
    | { value: string }
    | undefined
  if (row?.value === '1') return
  database
    .prepare(
      `
      UPDATE items SET project_id = NULL
      WHERE project_id IS NOT NULL
        AND IFNULL(source_file_path, '') != ''
        AND INSTR(lower(source_file_path), 'bookshelf-files') > 0
    `
    )
    .run()
  database
    .prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (@key, '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
    )
    .run({ key: BOOKSHELF_PATH_REPAIR_KEY })
}

function inferAssetDocKind(extension: string): string {
  const e = (extension || '').toLowerCase()
  if (e === '.pdf') return 'pdf'
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(e)) return 'image'
  if (e === '.doc' || e === '.docx') return 'word'
  return 'other'
}

function resolveNoteItemProjectId(projectId?: number | null): number | null {
  if (projectId === null) return null
  const n = Number(projectId)
  if (Number.isFinite(n) && n > 0) return n
  throw new Error('笔记须指定有效 projectId（正整数）或 null（书柜）')
}

function resolveDocumentItemProjectId(projectId?: number | null): number | null {
  if (projectId === null) return null
  const n = Number(projectId)
  if (Number.isFinite(n) && n > 0) return n
  throw new Error('文档条目须指定有效 projectId 或 null（书柜）')
}

function strictListProjectId(projectId?: number | null): number | null {
  if (projectId == null || !Number.isFinite(Number(projectId)) || Number(projectId) <= 0) return null
  return Number(projectId)
}

function ensureNotebookHierarchyColumns(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(notebooks)').all() as Array<{ name: string }>
  const columnNames = new Set(columns.map((column) => column.name))
  if (!columnNames.has('parent_id')) {
    database.exec('ALTER TABLE notebooks ADD COLUMN parent_id INTEGER;')
  }
  if (!columnNames.has('sort_order')) {
    database.exec('ALTER TABLE notebooks ADD COLUMN sort_order INTEGER DEFAULT 0;')
  }
}

function ensureProjectUiAndAiTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_ui_state (
      project_id    INTEGER PRIMARY KEY,
      ui_json       TEXT NOT NULL DEFAULT '{}',
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_chat_topics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL,
      title         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_topics_project_id ON ai_chat_topics(project_id);

    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id      INTEGER NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content       TEXT NOT NULL,
      chart_json    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (topic_id) REFERENCES ai_chat_topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_topic_id ON ai_chat_messages(topic_id);
  `)
  ensureGlobalAiTables(database)
}

function ensureGlobalAiTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS global_ai_chat_topics (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS global_ai_chat_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id      INTEGER NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content       TEXT NOT NULL,
      chart_json    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (topic_id) REFERENCES global_ai_chat_topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_global_ai_chat_messages_topic_id ON global_ai_chat_messages(topic_id);

    CREATE TABLE IF NOT EXISTS global_ai_topic_projects (
      topic_id    INTEGER NOT NULL,
      project_id  INTEGER NOT NULL,
      PRIMARY KEY (topic_id, project_id),
      FOREIGN KEY (topic_id) REFERENCES global_ai_chat_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS global_ai_topic_notes (
      topic_id    INTEGER NOT NULL,
      item_id     INTEGER NOT NULL,
      PRIMARY KEY (topic_id, item_id),
      FOREIGN KEY (topic_id) REFERENCES global_ai_chat_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS knowledge_fragments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL DEFAULT '',
      content          TEXT NOT NULL DEFAULT '',
      source_branch_id INTEGER NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_branch_id) REFERENCES global_ai_chat_topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_fragments_branch ON knowledge_fragments(source_branch_id);
  `)
  migrateLegacyGlobalAiLinkedProjectsToTopics(database)
}

const GLOBAL_AI_BRANCH_LINKS_MIGRATED_KEY = 'global_ai_branch_links_migrated_v18'

/** 将旧版 settings 中的全局关联项目一次性复制到各对话分支，便于按分支管理上下文 */
function migrateLegacyGlobalAiLinkedProjectsToTopics(database: Database.Database): void {
  const done = database.prepare('SELECT value FROM settings WHERE key = ?').get(GLOBAL_AI_BRANCH_LINKS_MIGRATED_KEY) as
    | { value: string }
    | undefined
  if (done?.value === '1') return

  const legacyRow = database.prepare('SELECT value FROM settings WHERE key = ?').get(GLOBAL_AI_LINKED_PROJECTS_KEY) as
    | { value: string }
    | undefined
  let legacy: number[] = []
  if (legacyRow?.value?.trim()) {
    try {
      const parsed = JSON.parse(legacyRow.value) as unknown
      if (Array.isArray(parsed)) {
        legacy = [...new Set(parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))]
      }
    } catch {
      legacy = []
    }
  }

  if (legacy.length > 0) {
    const topics = database.prepare('SELECT id FROM global_ai_chat_topics').all() as Array<{ id: number }>
    const ins = database.prepare(
      'INSERT OR IGNORE INTO global_ai_topic_projects (topic_id, project_id) VALUES (?, ?)'
    )
    for (const t of topics) {
      for (const pid of legacy) {
        const ok = database.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid) as { '1': number } | undefined
        if (ok) ins.run(t.id, pid)
      }
    }
  }

  database
    .prepare(
      `
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `
    )
    .run(GLOBAL_AI_BRANCH_LINKS_MIGRATED_KEY)
}

export type DashboardUiPersistV1 = {
  statField: string
  catField: string
  groupField: string
  aggregateField: string
  aggregateType: 'sum' | 'avg' | 'count'
}

export type ChartCardKind = 'category_pie' | 'group_bar'

export type ChartLegendPosition = 'top' | 'bottom' | 'left' | 'right'

export type ChartCardConfig = {
  id: string
  kind: ChartCardKind
  title?: string
  catField?: string
  groupField?: string
  aggregateField?: string
  aggregateType?: 'sum' | 'avg' | 'count'
  /** 分类图：pie | bar；分组图：bar | line */
  chartStyle?: 'pie' | 'bar' | 'line'
  xAxisName?: string
  yAxisName?: string
  color?: string
  legendPosition?: ChartLegendPosition
  cardWidthPx?: number
  chartHeightPx?: number
  /** 标题字号 */
  titleFontSize?: number
  /** 坐标轴标签字号 */
  axisFontSize?: number
}

export type ProjectUiStateV1 = {
  dashboard: DashboardUiPersistV1
  workspace: {
    tableFilter: string
    searchKeyword: string
    /** 项目工作区上次打开的标签页 */
    workspaceTab?: 'dashboard' | 'raw' | 'notes' | 'graph'
  }
  aiCurrentTopicId: number | null
  chartConfigurations?: ChartCardConfig[]
}

function parseChartConfigurations(input: unknown): ChartCardConfig[] | undefined {
  if (input === undefined) return undefined
  if (input === null) return []
  if (!Array.isArray(input)) return []
  const out: ChartCardConfig[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `c_${Math.random().toString(36).slice(2, 11)}`
    const kind: ChartCardKind | null =
      o.kind === 'group_bar' ? 'group_bar' : o.kind === 'category_pie' ? 'category_pie' : null
    if (!kind) continue
    const aggRaw = String(o.aggregateType ?? 'sum').toLowerCase()
    const aggregateType: ChartCardConfig['aggregateType'] =
      aggRaw === 'avg' || aggRaw === 'average' ? 'avg' : aggRaw === 'count' ? 'count' : 'sum'
    const cs = typeof o.chartStyle === 'string' ? o.chartStyle.toLowerCase() : ''
    const chartStyle: ChartCardConfig['chartStyle'] =
      cs === 'pie' || cs === 'bar' || cs === 'line' ? (cs as 'pie' | 'bar' | 'line') : undefined
    const lp = typeof o.legendPosition === 'string' ? o.legendPosition.toLowerCase() : ''
    const legendPosition: ChartCardConfig['legendPosition'] =
      lp === 'top' || lp === 'bottom' || lp === 'left' || lp === 'right' ? (lp as ChartLegendPosition) : undefined
    const cardWidthPx =
      typeof o.cardWidthPx === 'number' && Number.isFinite(o.cardWidthPx)
        ? Math.min(900, Math.max(200, Math.round(o.cardWidthPx)))
        : undefined
    const chartHeightPx =
      typeof o.chartHeightPx === 'number' && Number.isFinite(o.chartHeightPx)
        ? Math.min(800, Math.max(120, Math.round(o.chartHeightPx)))
        : undefined
    const titleFontSize =
      typeof o.titleFontSize === 'number' && Number.isFinite(o.titleFontSize)
        ? Math.min(22, Math.max(10, Math.round(o.titleFontSize)))
        : undefined
    const axisFontSize =
      typeof o.axisFontSize === 'number' && Number.isFinite(o.axisFontSize)
        ? Math.min(18, Math.max(8, Math.round(o.axisFontSize)))
        : undefined
    out.push({
      id,
      kind,
      title: typeof o.title === 'string' ? o.title : undefined,
      catField: typeof o.catField === 'string' ? o.catField : undefined,
      groupField: typeof o.groupField === 'string' ? o.groupField : undefined,
      aggregateField: typeof o.aggregateField === 'string' ? o.aggregateField : undefined,
      aggregateType,
      chartStyle,
      xAxisName: typeof o.xAxisName === 'string' ? o.xAxisName : undefined,
      yAxisName: typeof o.yAxisName === 'string' ? o.yAxisName : undefined,
      color: typeof o.color === 'string' ? o.color : undefined,
      legendPosition,
      cardWidthPx,
      chartHeightPx,
      titleFontSize,
      axisFontSize
    })
  }
  return out
}

function defaultDashboardUi(): DashboardUiPersistV1 {
  return {
    statField: '',
    catField: '',
    groupField: '',
    aggregateField: '',
    aggregateType: 'sum'
  }
}

function defaultProjectUiState(): ProjectUiStateV1 {
  return {
    dashboard: defaultDashboardUi(),
    workspace: { tableFilter: 'all', searchKeyword: '', workspaceTab: 'dashboard' },
    aiCurrentTopicId: null
  }
}

export function getProjectUiState(projectId: number): ProjectUiStateV1 {
  const database = getDb()
  const row = database.prepare('SELECT ui_json FROM project_ui_state WHERE project_id = ?').get(projectId) as
    | { ui_json: string }
    | undefined
  if (!row?.ui_json?.trim()) return defaultProjectUiState()
  try {
    const parsed = JSON.parse(row.ui_json) as Partial<ProjectUiStateV1>
    const base = defaultProjectUiState()
    const aggRaw = String((parsed.dashboard as { aggregateType?: string } | undefined)?.aggregateType ?? 'sum').toLowerCase()
    const aggregateType: DashboardUiPersistV1['aggregateType'] =
      aggRaw === 'avg' || aggRaw === 'average' ? 'avg' : aggRaw === 'count' ? 'count' : 'sum'
    return {
      ...base,
      ...parsed,
      dashboard: {
        ...defaultDashboardUi(),
        ...(parsed.dashboard ?? {}),
        aggregateType
      },
      workspace: {
        ...base.workspace,
        ...(parsed.workspace ?? {})
      },
      aiCurrentTopicId:
        typeof parsed.aiCurrentTopicId === 'number' && Number.isFinite(parsed.aiCurrentTopicId)
          ? parsed.aiCurrentTopicId
          : parsed.aiCurrentTopicId === null
            ? null
            : base.aiCurrentTopicId,
      chartConfigurations: parseChartConfigurations(
        'chartConfigurations' in (parsed as object) ? (parsed as { chartConfigurations?: unknown }).chartConfigurations : undefined
      )
    }
  } catch {
    return defaultProjectUiState()
  }
}

export function saveProjectUiState(projectId: number, state: ProjectUiStateV1): void {
  const database = getDb()
  const merged: ProjectUiStateV1 = {
    ...defaultProjectUiState(),
    ...state,
    dashboard: {
      ...defaultDashboardUi(),
      ...state.dashboard,
      aggregateType: state.dashboard?.aggregateType === 'avg' || state.dashboard?.aggregateType === 'count' ? state.dashboard.aggregateType : 'sum'
    },
    workspace: {
      ...defaultProjectUiState().workspace,
      ...state.workspace
    },
    chartConfigurations: state.chartConfigurations
  }
  database
    .prepare(`
      INSERT INTO project_ui_state (project_id, ui_json, updated_at)
      VALUES (@project_id, @ui_json, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        ui_json = excluded.ui_json,
        updated_at = excluded.updated_at
    `)
    .run({ project_id: projectId, ui_json: JSON.stringify(merged) })
}

export type AiTopicRow = {
  id: number
  /** 项目话题为项目 id；全局 AI 话题为 null */
  project_id: number | null
  title: string
  created_at: string
  updated_at: string
}

export type AiMessageRow = {
  id: number
  topic_id: number
  role: 'user' | 'assistant'
  content: string
  chart_json: string | null
  created_at: string
}

export function listAiTopics(projectId: number): AiTopicRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, project_id, title, created_at, updated_at
      FROM ai_chat_topics
      WHERE project_id = ?
      ORDER BY datetime(updated_at) DESC, id DESC
    `
    )
    .all(projectId) as AiTopicRow[]
}

export function createAiTopic(projectId: number, title: string): number {
  const database = getDb()
  const normalized = title.trim() || '新分支'
  const result = database.prepare('INSERT INTO ai_chat_topics (project_id, title) VALUES (?, ?)').run(projectId, normalized)
  return Number(result.lastInsertRowid)
}

export function renameAiTopic(topicId: number, title: string): void {
  getDb()
    .prepare(`UPDATE ai_chat_topics SET title = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(title.trim() || '未命名分支', topicId)
}

export function deleteAiTopic(topicId: number): void {
  getDb().prepare('DELETE FROM ai_chat_topics WHERE id = ?').run(topicId)
}

export function listAiMessages(topicId: number): AiMessageRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, topic_id, role, content, chart_json, created_at
      FROM ai_chat_messages
      WHERE topic_id = ?
      ORDER BY id ASC
    `
    )
    .all(topicId) as AiMessageRow[]
}

export function appendAiMessage(
  topicId: number,
  role: 'user' | 'assistant',
  content: string,
  chartJson?: string | null
): void {
  const database = getDb()
  database
    .prepare('INSERT INTO ai_chat_messages (topic_id, role, content, chart_json) VALUES (?, ?, ?, ?)')
    .run(topicId, role, content, chartJson ?? null)
  database.prepare(`UPDATE ai_chat_topics SET updated_at = datetime('now') WHERE id = ?`).run(topicId)
}

const GLOBAL_AI_CURRENT_TOPIC_KEY = 'global_ai_current_topic_id'

export function getGlobalAiCurrentTopicId(): number | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(GLOBAL_AI_CURRENT_TOPIC_KEY) as
    | { value: string }
    | undefined
  if (!row?.value?.trim()) return null
  const n = Number(row.value)
  return Number.isFinite(n) ? n : null
}

export function setGlobalAiCurrentTopicId(topicId: number | null): void {
  const database = getDb()
  if (topicId == null) {
    database.prepare('DELETE FROM settings WHERE key = ?').run(GLOBAL_AI_CURRENT_TOPIC_KEY)
  } else {
    database
      .prepare(
        `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `
      )
      .run(GLOBAL_AI_CURRENT_TOPIC_KEY, String(topicId))
  }
}

const GLOBAL_AI_LINKED_PROJECTS_KEY = 'global_ai_linked_project_ids'

export function getGlobalAiLinkedProjectIds(): number[] {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(GLOBAL_AI_LINKED_PROJECTS_KEY) as
    | { value: string }
    | undefined
  if (!row?.value?.trim()) return []
  try {
    const parsed = JSON.parse(row.value) as unknown
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))]
  } catch {
    return []
  }
}

export function setGlobalAiLinkedProjectIds(projectIds: number[]): void {
  const uniq = [...new Set(projectIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const database = getDb()
  if (uniq.length === 0) {
    database.prepare('DELETE FROM settings WHERE key = ?').run(GLOBAL_AI_LINKED_PROJECTS_KEY)
  } else {
    database
      .prepare(
        `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `
      )
      .run(GLOBAL_AI_LINKED_PROJECTS_KEY, JSON.stringify(uniq))
  }
}

export function listGlobalAiTopics(): AiTopicRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, NULL AS project_id, title, created_at, updated_at
      FROM global_ai_chat_topics
      ORDER BY datetime(updated_at) DESC, id DESC
    `
    )
    .all() as AiTopicRow[]
}

export function createGlobalAiTopic(title: string): number {
  const database = getDb()
  const normalized = title.trim() || '新分支'
  const result = database.prepare('INSERT INTO global_ai_chat_topics (title) VALUES (?)').run(normalized)
  return Number(result.lastInsertRowid)
}

export function renameGlobalAiTopic(topicId: number, title: string): void {
  getDb()
    .prepare(`UPDATE global_ai_chat_topics SET title = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(title.trim() || '未命名分支', topicId)
}

export function deleteGlobalAiTopic(topicId: number): void {
  getDb().prepare('DELETE FROM global_ai_chat_topics WHERE id = ?').run(topicId)
  const cur = getGlobalAiCurrentTopicId()
  if (cur === topicId) {
    setGlobalAiCurrentTopicId(null)
  }
}

export function listGlobalAiMessages(topicId: number): AiMessageRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, topic_id, role, content, chart_json, created_at
      FROM global_ai_chat_messages
      WHERE topic_id = ?
      ORDER BY id ASC
    `
    )
    .all(topicId) as AiMessageRow[]
}

export function appendGlobalAiMessage(
  topicId: number,
  role: 'user' | 'assistant',
  content: string,
  chartJson?: string | null
): void {
  const database = getDb()
  database
    .prepare('INSERT INTO global_ai_chat_messages (topic_id, role, content, chart_json) VALUES (?, ?, ?, ?)')
    .run(topicId, role, content, chartJson ?? null)
  database.prepare(`UPDATE global_ai_chat_topics SET updated_at = datetime('now') WHERE id = ?`).run(topicId)
}

export function getGlobalAiTopicLinkedProjectIds(topicId: number): number[] {
  const tid = Number(topicId)
  if (!Number.isFinite(tid) || tid <= 0) return []
  const rows = getDb()
    .prepare('SELECT project_id FROM global_ai_topic_projects WHERE topic_id = ? ORDER BY project_id ASC')
    .all(tid) as Array<{ project_id: number }>
  return rows.map((r) => r.project_id)
}

export function setGlobalAiTopicLinkedProjectIds(topicId: number, projectIds: number[]): void {
  const database = getDb()
  const tid = Number(topicId)
  if (!Number.isFinite(tid) || tid <= 0) return
  const uniq = [...new Set(projectIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
  database.prepare('DELETE FROM global_ai_topic_projects WHERE topic_id = ?').run(tid)
  const ins = database.prepare('INSERT INTO global_ai_topic_projects (topic_id, project_id) VALUES (?, ?)')
  for (const pid of uniq) {
    const ok = database.prepare('SELECT 1 FROM projects WHERE id = ?').get(pid) as { '1': number } | undefined
    if (ok) ins.run(tid, pid)
  }
}

export function getGlobalAiTopicLinkedNoteIds(topicId: number): number[] {
  const tid = Number(topicId)
  if (!Number.isFinite(tid) || tid <= 0) return []
  const rows = getDb()
    .prepare('SELECT item_id FROM global_ai_topic_notes WHERE topic_id = ? ORDER BY item_id ASC')
    .all(tid) as Array<{ item_id: number }>
  return rows.map((r) => r.item_id)
}

export function setGlobalAiTopicLinkedNoteIds(topicId: number, itemIds: number[]): void {
  const database = getDb()
  const tid = Number(topicId)
  if (!Number.isFinite(tid) || tid <= 0) return
  const uniq = [...new Set(itemIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
  database.prepare('DELETE FROM global_ai_topic_notes WHERE topic_id = ?').run(tid)
  const ins = database.prepare('INSERT INTO global_ai_topic_notes (topic_id, item_id) VALUES (?, ?)')
  for (const iid of uniq) {
    const ok = database
      .prepare(`SELECT 1 FROM items WHERE id = ? AND type = 'note' AND project_id IS NULL`)
      .get(iid) as { '1': number } | undefined
    if (ok) ins.run(tid, iid)
  }
}

export type BookshelfNotePickerRow = { id: number; title: string }

export function listBookshelfNotesForGlobalAiPicker(): BookshelfNotePickerRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, title FROM items
      WHERE project_id IS NULL AND type = 'note'
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 800
    `
    )
    .all() as BookshelfNotePickerRow[]
}

export type KnowledgeFragmentRow = {
  id: number
  title: string
  content: string
  source_branch_id: number
  created_at: string
  updated_at: string
}

export function insertKnowledgeFragment(sourceBranchId: number, title: string, content: string): number {
  const database = getDb()
  const tid = Number(sourceBranchId)
  if (!Number.isFinite(tid) || tid <= 0) throw new Error('无效分支')
  const t = title.trim() || '未命名主题'
  const c = content.trim()
  if (!c) throw new Error('知识内容不能为空')
  const topicExists = database.prepare('SELECT 1 FROM global_ai_chat_topics WHERE id = ?').get(tid) as
    | { '1': number }
    | undefined
  if (!topicExists) throw new Error('分支不存在')
  const r = database
    .prepare('INSERT INTO knowledge_fragments (title, content, source_branch_id) VALUES (?, ?, ?)')
    .run(t, c, tid)
  return Number(r.lastInsertRowid)
}

function tokenizeKnowledgeQuery(q: string): string[] {
  const raw = q.trim()
  if (!raw) return []
  const parts = raw
    .split(/[\s\u3000,，.;；、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = new Set<string>()
  for (const p of parts) {
    if (p.length >= 2) out.add(p)
  }
  if (out.size === 0) {
    const one = raw.replace(/\s+/g, '').slice(0, 48)
    if (one.length) out.add(one)
  }
  return [...out].slice(0, 14)
}

export function searchKnowledgeFragmentsByKeywords(query: string, limit = 8): KnowledgeFragmentRow[] {
  const database = getDb()
  const rawTokens = tokenizeKnowledgeQuery(query)
  const tokenPatterns: Array<{ pat: string }> = []
  for (const tok of rawTokens) {
    const safe = tok.replace(/%/g, '').replace(/_/g, '').slice(0, 64)
    if (!safe) continue
    tokenPatterns.push({ pat: `%${safe}%` })
  }
  if (tokenPatterns.length === 0) return []
  const clauses = tokenPatterns
    .map(() => '(IFNULL(title, "") LIKE ? COLLATE NOCASE OR IFNULL(content, "") LIKE ? COLLATE NOCASE)')
    .join(' OR ')
  const args: (string | number)[] = []
  for (const tp of tokenPatterns) {
    args.push(tp.pat, tp.pat)
  }
  const lim = Math.min(24, Math.max(1, Math.floor(Number(limit)) || 8))
  const sql = `
    SELECT id, title, content, source_branch_id, created_at, updated_at
    FROM knowledge_fragments
    WHERE ${clauses}
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT ?
  `
  return database.prepare(sql).all(...args, lim) as KnowledgeFragmentRow[]
}

export function buildGlobalAiLinkedNotesContextBlock(itemIds: number[]): string {
  const database = getDb()
  const ids = [...new Set(itemIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))].slice(0, 24)
  const lines: string[] = []
  for (const rawId of ids) {
    const row = database
      .prepare(`SELECT id, title, content_text FROM items WHERE id = ? AND type = 'note' AND project_id IS NULL`)
      .get(rawId) as { id: number; title: string; content_text: string } | undefined
    if (!row) continue
    const plain = (row.content_text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4500)
    lines.push(`【书柜笔记 #${row.id}】${row.title || '未命名'}\n${plain || '（无正文）'}`)
  }
  return lines.join('\n\n---\n\n')
}

export function formatKnowledgeFragmentsForPrompt(rows: KnowledgeFragmentRow[]): string {
  if (!rows.length) return ''
  const parts = rows.map((r, i) => `（${i + 1}）${r.title || '知识片段'}\n${(r.content || '').trim()}`)
  return parts.join('\n\n---\n\n').slice(0, 12000)
}

function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined
  return Boolean(row)
}

function ensureItemsSupportsAssetNodes(database: Database.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get() as
    | { sql: string }
    | undefined
  if (!row || row.sql.includes("'file'")) return

  const hasNodeTags = tableExists(database, 'node_tags')
  const hasNodeRelations = tableExists(database, 'node_relations')
  database.pragma('foreign_keys = OFF')
  try {
    database.exec(`
      DROP TABLE IF EXISTS temp.__node_tags_backup;
      DROP TABLE IF EXISTS temp.__node_relations_backup;
      CREATE TEMP TABLE __node_tags_backup (node_id INTEGER, tag_id INTEGER);
      CREATE TEMP TABLE __node_relations_backup (
        id INTEGER,
        source_id INTEGER,
        target_id INTEGER,
        relation_label TEXT
      );
    `)
    if (hasNodeTags) {
      database.exec('INSERT INTO temp.__node_tags_backup SELECT * FROM node_tags; DROP TABLE node_tags;')
    }
    if (hasNodeRelations) {
      database.exec('INSERT INTO temp.__node_relations_backup SELECT * FROM node_relations; DROP TABLE node_relations;')
    }
    database.exec(`
      ALTER TABLE items RENAME TO items_asset_migration_old;
      ${createItemsTableSql()}
      INSERT INTO items (
        id, notebook_id, project_id, type, title, source_file_path, source_file_hash, source_row_index,
        content_text, content_json, tags, ai_embedding, ai_model, ai_embedded_at, created_at, updated_at
      )
      SELECT
        id, notebook_id, project_id, type, title, source_file_path, source_file_hash, source_row_index,
        content_text, content_json, tags, ai_embedding, ai_model, ai_embedded_at, created_at, updated_at
      FROM items_asset_migration_old;
      DROP TABLE items_asset_migration_old;

      CREATE TABLE IF NOT EXISTS node_tags (
        node_id          INTEGER NOT NULL,
        tag_id           INTEGER NOT NULL,
        PRIMARY KEY (node_id, tag_id),
        FOREIGN KEY (node_id) REFERENCES items(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS node_relations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id        INTEGER NOT NULL,
        target_id        INTEGER NOT NULL,
        relation_label   TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (source_id) REFERENCES items(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES items(id) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO node_tags (node_id, tag_id)
      SELECT node_id, tag_id FROM temp.__node_tags_backup
      WHERE EXISTS (SELECT 1 FROM items WHERE id = node_id)
        AND EXISTS (SELECT 1 FROM tags WHERE id = tag_id);

      INSERT OR IGNORE INTO node_relations (id, source_id, target_id, relation_label)
      SELECT id, source_id, target_id, relation_label FROM temp.__node_relations_backup
      WHERE EXISTS (SELECT 1 FROM items WHERE id = source_id)
        AND EXISTS (SELECT 1 FROM items WHERE id = target_id);

      DROP TABLE IF EXISTS temp.__node_tags_backup;
      DROP TABLE IF EXISTS temp.__node_relations_backup;
    `)
  } finally {
    database.pragma('foreign_keys = ON')
  }
}

export function initDatabase(): void {
  if (initialized) return
  const database = getDb()
  database.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      parent_id       INTEGER,
      description     TEXT DEFAULT '',
      color           TEXT DEFAULT '',
      sort_order      INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES notebooks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notebooks_parent_id ON notebooks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_notebooks_name ON notebooks(name);

    CREATE TABLE IF NOT EXISTS projects (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    ${createItemsTableSql()}

    CREATE INDEX IF NOT EXISTS idx_items_notebook_id ON items(notebook_id);
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at);
    CREATE INDEX IF NOT EXISTS idx_items_source_file_path ON items(source_file_path);

    CREATE TABLE IF NOT EXISTS settings (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL DEFAULT '',
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 标签主表：维护标签名称与展示颜色
    CREATE TABLE IF NOT EXISTS tags (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      color           TEXT NOT NULL DEFAULT '#3b82f6'
    );

    -- 节点-标签多对多关联表（当前项目以 items 作为数据节点）
    CREATE TABLE IF NOT EXISTS node_tags (
      node_id          INTEGER NOT NULL,
      tag_id           INTEGER NOT NULL,
      PRIMARY KEY (node_id, tag_id),
      FOREIGN KEY (node_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- 图谱关系表：source -> target 的有向边
    CREATE TABLE IF NOT EXISTS node_relations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id        INTEGER NOT NULL,
      target_id        INTEGER NOT NULL,
      relation_label   TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (source_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    CREATE INDEX IF NOT EXISTS idx_node_tags_node_id ON node_tags(node_id);
    CREATE INDEX IF NOT EXISTS idx_node_tags_tag_id ON node_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_rel_source_id ON node_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target_id ON node_relations(target_id);
  `)

  const defaultProjectId = ensureProjects(database)
  ensureNotebookHierarchyColumns(database)
  ensureItemsProjectColumn(database, defaultProjectId)
  ensureItemsSupportsAssetNodes(database)
  ensureItemPositionColumns(database)
  ensureProjectUiAndAiTables(database)
  runV16BookshelfPathRepair(database)

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_tags_node_id ON node_tags(node_id);
    CREATE INDEX IF NOT EXISTS idx_node_tags_tag_id ON node_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_rel_source_id ON node_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target_id ON node_relations(target_id);
    CREATE INDEX IF NOT EXISTS idx_items_project_id ON items(project_id);
  `)

  const count = database.prepare('SELECT COUNT(*) AS count FROM notebooks').get() as { count: number }
  if (count.count === 0) {
    database
      .prepare("INSERT INTO notebooks (name, description) VALUES ('默认笔记本', '系统初始化创建')")
      .run()
  }
  initialized = true
}

export type NotebookRow = {
  id: number
  name: string
  parent_id: number | null
  created_at: string
}

export type ProjectRow = {
  id: number
  name: string
  created_at: string
}

export function listProjects(): ProjectRow[] {
  const database = getDb()
  return database.prepare('SELECT id, name, created_at FROM projects ORDER BY id ASC').all() as ProjectRow[]
}

export function createProject(name: string): ProjectRow {
  const database = getDb()
  const normalized = name.trim()
  if (!normalized) throw new Error('项目名称不能为空')
  const result = database.prepare('INSERT INTO projects (name) VALUES (?)').run(normalized)
  return database
    .prepare('SELECT id, name, created_at FROM projects WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as ProjectRow
}

export function getDefaultProjectId(): number {
  return ensureProjects(getDb())
}

export function deleteProject(projectId: number): void {
  const database = getDb()
  const count = database.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }
  if (count.count <= 1) throw new Error('至少需要保留一个项目')
  const tx = database.transaction(() => {
    const itemIds = database.prepare('SELECT id FROM items WHERE project_id = ?').all(projectId) as Array<{ id: number }>
    for (const row of itemIds) {
      database.prepare('DELETE FROM node_relations WHERE source_id = ? OR target_id = ?').run(row.id, row.id)
      database.prepare('DELETE FROM node_tags WHERE node_id = ?').run(row.id)
    }
    database.prepare('DELETE FROM items WHERE project_id = ?').run(projectId)
    database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })
  tx()
}

export function listNotebooks(): NotebookRow[] {
  return listNotebookTree()
}

export function listNotebookTree(): NotebookRow[] {
  const database = getDb()
  return database
    .prepare(
      `
      SELECT id, name, parent_id, created_at
      FROM notebooks
      ORDER BY (parent_id IS NULL) DESC, sort_order ASC, id ASC
    `
    )
    .all() as NotebookRow[]
}

export function createNotebook(name: string, parentId?: number | null): number {
  const database = getDb()
  const n = name.trim() || '新建文件夹'
  const pid =
    parentId != null && Number.isFinite(Number(parentId)) && Number(parentId) > 0 ? Number(parentId) : null
  const result = database.prepare('INSERT INTO notebooks (name, parent_id, description) VALUES (?, ?, ?)').run(n, pid, '')
  return Number(result.lastInsertRowid)
}

export function renameNotebook(notebookId: number, name: string): void {
  getDb()
    .prepare(`UPDATE notebooks SET name = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name.trim() || '未命名文件夹', notebookId)
}

export function deleteNotebook(notebookId: number): void {
  const database = getDb()
  const children = database.prepare('SELECT COUNT(*) AS c FROM notebooks WHERE parent_id = ?').get(notebookId) as {
    c: number
  }
  if (Number(children.c) > 0) {
    throw new Error('请先删除或移动子文件夹')
  }
  database.prepare('DELETE FROM items WHERE notebook_id = ? AND project_id IS NULL').run(notebookId)
  database.prepare('DELETE FROM notebooks WHERE id = ?').run(notebookId)
}

function notebookIsDescendant(database: ReturnType<typeof getDb>, ancestorId: number, candidateParentId: number): boolean {
  let cur: number | null = candidateParentId
  const seen = new Set<number>()
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    if (cur === ancestorId) return true
    const row = database.prepare('SELECT parent_id FROM notebooks WHERE id = ?').get(cur) as { parent_id: number | null } | undefined
    cur = row?.parent_id ?? null
  }
  return false
}

export function moveNotebookToParent(notebookId: number, parentId: number | null): void {
  const database = getDb()
  if (parentId === notebookId) throw new Error('不能将文件夹放入自身')
  const self = database.prepare('SELECT id FROM notebooks WHERE id = ?').get(notebookId) as { id: number } | undefined
  if (!self) throw new Error('文件夹不存在')
  if (parentId != null) {
    const p = database.prepare('SELECT id FROM notebooks WHERE id = ?').get(parentId) as { id: number } | undefined
    if (!p) throw new Error('目标父文件夹不存在')
    if (notebookIsDescendant(database, notebookId, parentId)) {
      throw new Error('不能将父文件夹移动到其子文件夹中')
    }
  }
  database.prepare('UPDATE notebooks SET parent_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(parentId, notebookId)
}

export function moveBookshelfItemToNotebook(itemId: number, notebookId: number): void {
  const database = getDb()
  const nb = database.prepare('SELECT id FROM notebooks WHERE id = ?').get(notebookId) as { id: number } | undefined
  if (!nb) throw new Error('目标文件夹不存在')
  const row = database
    .prepare('SELECT id, project_id FROM items WHERE id = ?')
    .get(itemId) as { id: number; project_id: number | null } | undefined
  if (!row) throw new Error('条目不存在')
  if (row.project_id != null) throw new Error('仅能移动书柜内全局条目')
  database
    .prepare('UPDATE items SET notebook_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(notebookId, itemId)
}

export function deleteBookshelfGlobalItem(itemId: number): void {
  const database = getDb()
  const row = database.prepare('SELECT id, project_id FROM items WHERE id = ?').get(itemId) as
    | { id: number; project_id: number | null }
    | undefined
  if (!row) throw new Error('条目不存在')
  if (row.project_id != null) throw new Error('非书柜全局条目')
  database.prepare('DELETE FROM node_relations WHERE source_id = ? OR target_id = ?').run(itemId, itemId)
  database.prepare('DELETE FROM node_tags WHERE node_id = ?').run(itemId)
  database.prepare('DELETE FROM items WHERE id = ?').run(itemId)
}

/** 批量删除书柜全局条目（跳过无效 id） */
export function deleteBookshelfGlobalItems(itemIds: number[]): { ok: number; failed: number } {
  const uniq = [...new Set(itemIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
  let ok = 0
  let failed = 0
  for (const id of uniq) {
    try {
      deleteBookshelfGlobalItem(id)
      ok++
    } catch {
      failed++
    }
  }
  return { ok, failed }
}

export function duplicateBookshelfNote(sourceId: number): number {
  const database = getDb()
  const row = database
    .prepare(
      'SELECT notebook_id, project_id, type, title, content_text, content_json FROM items WHERE id = ?'
    )
    .get(sourceId) as
    | {
        notebook_id: number
        project_id: number | null
        type: ItemRow['type']
        title: string
        content_text: string
        content_json: string
      }
    | undefined
  if (!row) throw new Error('笔记不存在')
  if (row.project_id != null) throw new Error('仅可复制书柜笔记')
  if (row.type !== 'note') throw new Error('仅支持笔记')
  const base = row.title?.trim() || '未命名笔记'
  const title = `${base} 副本`
  let mergedJson = JSON.stringify({ title })
  try {
    const p = row.content_json?.trim() ? (JSON.parse(row.content_json) as Record<string, unknown>) : {}
    mergedJson = JSON.stringify({ ...p, title })
  } catch {
    mergedJson = JSON.stringify({ title })
  }
  const body = row.content_text || '<p><br></p>'
  const newId = insertNoteItem({
    notebookId: row.notebook_id,
    projectId: null,
    title,
    contentText: body,
    tags: []
  })
  database.prepare(`UPDATE items SET content_json = ?, updated_at = datetime('now') WHERE id = ?`).run(mergedJson, newId)
  return newId
}

export function renameBookshelfItem(itemId: number, nextTitle: string): void {
  const database = getDb()
  const row = database
    .prepare('SELECT id, project_id, type, content_json FROM items WHERE id = ?')
    .get(itemId) as
    | { id: number; project_id: number | null; type: ItemRow['type']; content_json: string }
    | undefined
  if (!row) throw new Error('条目不存在')
  if (row.project_id != null) throw new Error('非书柜全局条目')
  const t = nextTitle.trim() || '未命名'
  let contentJson = row.content_json || ''
  if (row.type === 'note' || row.type === 'file') {
    try {
      const p = contentJson ? (JSON.parse(contentJson) as Record<string, unknown>) : {}
      contentJson = JSON.stringify({ ...p, title: t })
    } catch {
      contentJson = JSON.stringify({ title: t })
    }
  }
  database
    .prepare(`UPDATE items SET title = @title, content_json = @content_json, updated_at = datetime('now') WHERE id = @id`)
    .run({ id: itemId, title: t, content_json: contentJson })
}

/** 列出某文件夹及其所有子文件夹内的书柜全局条目（project_id IS NULL），便于父级视图看到子目录中的笔记 */
export function listBookshelfItems(notebookId: number): ItemRow[] {
  const database = getDb()
  return database
    .prepare(
      `
      WITH RECURSIVE sub(id) AS (
        SELECT @notebookId AS id
        UNION ALL
        SELECT n.id FROM notebooks n INNER JOIN sub s ON n.parent_id = s.id
      )
      SELECT i.id, i.notebook_id, i.project_id, i.type, i.title, i.content_text, i.content_json, i.source_file_path, i.created_at, i.updated_at
      FROM items i
      WHERE i.project_id IS NULL AND i.notebook_id IN (SELECT id FROM sub)
      ORDER BY datetime(COALESCE(i.updated_at, i.created_at)) DESC, i.id DESC
      LIMIT 2000
    `
    )
    .all({ notebookId }) as ItemRow[]
}

export function listAllBookshelfGlobalItems(): ItemRow[] {
  const database = getDb()
  return database
    .prepare(
      `
      SELECT id, notebook_id, project_id, type, title, content_text, content_json, source_file_path, created_at, updated_at
      FROM items
      WHERE project_id IS NULL
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, id DESC
      LIMIT 2000
    `
    )
    .all() as ItemRow[]
}

export function listBookshelfImportCandidates(): ItemRow[] {
  const database = getDb()
  return database
    .prepare(
      `
      SELECT id, notebook_id, project_id, type, title, content_text, content_json, source_file_path, created_at, updated_at
      FROM items
      WHERE project_id IS NULL
        AND type IN ('file', 'document')
        AND (
          lower(source_file_path) LIKE '%.xlsx'
          OR lower(source_file_path) LIKE '%.xls'
          OR lower(source_file_path) LIKE '%.csv'
          OR lower(source_file_path) LIKE '%.json'
        )
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 200
    `
    )
    .all() as ItemRow[]
}

export function listProjectDocuments(projectId: number): { notes: ItemRow[]; references: ItemRow[] } {
  const database = getDb()
  const pid = Number(projectId)
  if (!Number.isFinite(pid) || pid <= 0) return { notes: [], references: [] }
  const cols = `id, notebook_id, project_id, type, title, content_text, content_json, source_file_path, created_at, updated_at`
  const notes = database
    .prepare(
      `
      SELECT ${cols}
      FROM items
      WHERE project_id = @pid AND type = 'note'
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, id DESC
      LIMIT 500
    `
    )
    .all({ pid }) as ItemRow[]
  const references = database
    .prepare(
      `
      SELECT ${cols}
      FROM items
      WHERE project_id = @pid AND type IN ('document', 'file')
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, id DESC
      LIMIT 500
    `
    )
    .all({ pid }) as ItemRow[]
  return { notes, references }
}

export function listProjectNotes(projectId: number): ItemRow[] {
  return listProjectDocuments(projectId).notes
}

export type ItemRow = {
  id: number
  notebook_id?: number
  project_id: number | null
  type: 'note' | 'excel_row' | 'document' | 'file'
  title: string
  content_text: string
  content_json: string
  source_file_path: string
  created_at: string
  updated_at?: string
}

export function getDefaultNotebookId(): number {
  const database = getDb()
  const row = database
    .prepare('SELECT id FROM notebooks ORDER BY id ASC LIMIT 1')
    .get() as { id: number } | undefined

  if (row?.id) return row.id

  const result = database
    .prepare("INSERT INTO notebooks (name, description) VALUES ('默认笔记本', '自动创建')")
    .run()
  return Number(result.lastInsertRowid)
}

export type InsertExcelRowInput = {
  notebookId: number
  projectId: number
  sourceFilePath: string
  sourceRowIndex: number
  contentText: string
  contentJson: string
}

export function insertExcelRows(rows: InsertExcelRowInput[]): number {
  if (rows.length === 0) return 0
  const database = getDb()
  const defaultProjectId = getDefaultProjectId()
  const stmt = database.prepare(`
    INSERT INTO items (
      notebook_id, project_id, type, title, source_file_path, source_row_index,
      content_text, content_json
    ) VALUES (
      @notebookId, @projectId, 'excel_row', '', @sourceFilePath, @sourceRowIndex,
      @contentText, @contentJson
    )
  `)

  const tx = database.transaction((payload: InsertExcelRowInput[]) => {
    for (const row of payload) stmt.run({ ...row, projectId: Number.isFinite(row.projectId) ? row.projectId : defaultProjectId })
  })
  tx(rows)
  return rows.length
}

/** 供统计引擎：从 excel_row 解析出结构化对象列表（与导入时 content_json 一致） */
export function getExcelStructuredRowsForStats(projectId?: number, maxRows = 100000): Record<string, unknown>[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT content_json FROM items
    WHERE type = 'excel_row'
      AND content_json IS NOT NULL AND TRIM(content_json) != ''
      AND (@projectId IS NULL OR project_id = @projectId)
    ORDER BY id ASC
    LIMIT @maxRows
  `)
  const pid = Number.isFinite(projectId as number) ? projectId : null
  const rows = stmt.all({ projectId: pid, maxRows }) as Array<{ content_json: string }>
  const out: Record<string, unknown>[] = []
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.content_json) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
      /* skip bad json */
    }
  }
  return out
}

/** 合并多个项目的结构化行，并注入 _DataNodeProjectId 供跨项目统计 / 全局 AI */
export function getMergedExcelStructuredRowsForProjects(
  projectIds: number[],
  maxRowsPerProject = 40000
): Record<string, unknown>[] {
  const ids = [...new Set(projectIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  const out: Record<string, unknown>[] = []
  for (const pid of ids) {
    const rows = getExcelStructuredRowsForStats(pid, maxRowsPerProject)
    for (const row of rows) {
      out.push({ ...row, _DataNodeProjectId: pid })
    }
  }
  return out
}

export function countExcelRowsForStats(projectId?: number): number {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT COUNT(*) as c FROM items
    WHERE type = 'excel_row' AND (@projectId IS NULL OR project_id = @projectId)
  `)
  const pid = Number.isFinite(projectId as number) ? projectId : null
  const row = stmt.get({ projectId: pid }) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

/** AI 或「应用 JSON」批量写入，与 Excel 行存储格式一致 */
export function insertStructuredJsonRows(args: {
  projectId: number
  sourceFilePath: string
  rows: Record<string, unknown>[]
}): number {
  if (args.rows.length === 0) return 0
  const notebookId = getDefaultNotebookId()
  const defaultProjectId = getDefaultProjectId()
  const projectId = Number.isFinite(args.projectId) ? args.projectId : defaultProjectId
  const payload: InsertExcelRowInput[] = []
  args.rows.forEach((obj, idx) => {
    const stringRecord: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj)) {
      stringRecord[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
    }
    const contentText = Object.values(stringRecord).join(' ').trim()
    if (!contentText) return
    payload.push({
      notebookId,
      projectId,
      sourceFilePath: args.sourceFilePath,
      sourceRowIndex: idx + 1,
      contentText,
      contentJson: JSON.stringify(stringRecord)
    })
  })
  if (payload.length === 0) return 0
  return insertExcelRows(payload)
}

export function insertDocumentItem(args: {
  notebookId: number
  projectId?: number | null
  sourceFilePath: string
  contentText: string
  docKind?: string
}): number {
  const database = getDb()
  const projectId = resolveDocumentItemProjectId(args.projectId)
  const kind = args.docKind ?? 'word'
  const contentJson = JSON.stringify({ dnDocKind: kind })
  const result = database
    .prepare(`
      INSERT INTO items (notebook_id, project_id, type, title, source_file_path, content_text, content_json)
      VALUES (@notebookId, @projectId, 'document', '', @sourceFilePath, @contentText, @contentJson)
    `)
    .run({
      notebookId: args.notebookId,
      projectId,
      sourceFilePath: args.sourceFilePath,
      contentText: args.contentText,
      contentJson
    })
  return Number(result.lastInsertRowid)
}

export function insertAssetItem(args: {
  notebookId: number
  projectId?: number | null
  title: string
  sourceFilePath: string
  originalFilePath: string
  extension: string
}): number {
  const database = getDb()
  const projectId = resolveDocumentItemProjectId(args.projectId)
  const title = args.title.trim()
  const dnKind = inferAssetDocKind(args.extension)
  const result = database
    .prepare(`
      INSERT INTO items (notebook_id, project_id, type, title, source_file_path, content_text, content_json)
      VALUES (@notebookId, @projectId, 'file', @title, @sourceFilePath, @title, @contentJson)
    `)
    .run({
      notebookId: args.notebookId,
      projectId,
      title,
      sourceFilePath: args.sourceFilePath,
      contentJson: JSON.stringify({
        title,
        originalFilePath: args.originalFilePath,
        filePath: args.sourceFilePath,
        extension: args.extension,
        dnDocKind: dnKind
      })
    })
  return Number(result.lastInsertRowid)
}

export function listItems(projectId?: number): ItemRow[] {
  const database = getDb()
  const pid = strictListProjectId(projectId)
  if (pid == null) return []
  const stmt = database.prepare(`
    SELECT id, notebook_id, project_id, type, title, content_text, content_json, source_file_path, created_at
    FROM items
    WHERE project_id = @pid
    ORDER BY id DESC
    LIMIT 500
  `)
  return stmt.all({ pid }) as ItemRow[]
}

export function searchItems(keyword: string, projectId?: number): ItemRow[] {
  const database = getDb()
  const pid = strictListProjectId(projectId)
  if (pid == null) return []
  const normalized = keyword.trim()
  if (!normalized) return listItems(pid)

  const stmt = database.prepare(`
    SELECT id, notebook_id, project_id, type, title, content_text, content_json, source_file_path, created_at
    FROM items
    WHERE project_id = @pid
      AND (content_text LIKE @q OR content_json LIKE @q)
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 500
  `)
  return stmt.all({ q: `%${normalized}%`, pid }) as ItemRow[]
}

export function insertNoteItem(args: {
  notebookId: number
  /** null：书柜；正整数：所属项目（禁止省略，以免误入默认项目） */
  projectId?: number | null
  title: string
  contentText: string
  tags: string[]
}): number {
  const database = getDb()
  const projectId = resolveNoteItemProjectId(args.projectId)
  const text = args.contentText.trim()
  const title = args.title.trim()
  const normalizedTags = Array.from(
    new Set(
      (args.tags ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  )

  const tx = database.transaction(() => {
    const result = database
      .prepare(`
        INSERT INTO items (notebook_id, project_id, type, title, source_file_path, content_text, content_json, tags)
        VALUES (@notebookId, @projectId, 'note', @title, '', @contentText, @contentJson, @tagsJson)
      `)
      .run({
        notebookId: args.notebookId,
        projectId,
        title,
        contentText: text,
        contentJson: JSON.stringify({ title }),
        tagsJson: JSON.stringify(normalizedTags)
      })
    const nodeId = Number(result.lastInsertRowid)

    // 创建笔记时可直接附带初始标签，并写入 node_tags 关系
    for (const tagName of normalizedTags) {
      database
        .prepare(`
          INSERT INTO tags (name, color)
          VALUES (@name, @color)
          ON CONFLICT(name) DO NOTHING
        `)
        .run({ name: tagName, color: '#67C23A' })

      const tag = database.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as
        | { id: number }
        | undefined
      if (tag) {
        database.prepare('INSERT OR IGNORE INTO node_tags (node_id, tag_id) VALUES (?, ?)').run(nodeId, tag.id)
      }
    }

    return nodeId
  })

  return tx()
}

function mergeItemContentJson(database: Database.Database, itemId: number, patch: Record<string, unknown>): void {
  const r = database.prepare('SELECT content_json FROM items WHERE id = ?').get(itemId) as
    | { content_json: string }
    | undefined
  if (!r) return
  let base: Record<string, unknown> = {}
  try {
    base = r.content_json?.trim() ? (JSON.parse(r.content_json) as Record<string, unknown>) : {}
  } catch {
    base = {}
  }
  const merged = JSON.stringify({ ...base, ...patch })
  database.prepare(`UPDATE items SET content_json = @cj, updated_at = datetime('now') WHERE id = @id`).run({
    cj: merged,
    id: itemId
  })
}

export function renameProjectItem(itemId: number, projectId: number, nextTitle: string): void {
  const database = getDb()
  const pid = Number(projectId)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('无效项目')
  const row = database
    .prepare('SELECT id, project_id, type, content_json FROM items WHERE id = ?')
    .get(itemId) as
    | { id: number; project_id: number | null; type: ItemRow['type']; content_json: string }
    | undefined
  if (!row) throw new Error('条目不存在')
  if (row.project_id !== pid) throw new Error('非当前项目条目')
  const t = nextTitle.trim() || '未命名'
  let contentJson = row.content_json || ''
  try {
    const p = contentJson ? (JSON.parse(contentJson) as Record<string, unknown>) : {}
    contentJson = JSON.stringify({ ...p, title: t })
  } catch {
    contentJson = JSON.stringify({ title: t })
  }
  database
    .prepare(`UPDATE items SET title = @title, content_json = @cj, updated_at = datetime('now') WHERE id = @id`)
    .run({ id: itemId, title: t, cj: contentJson })
}

/** 删除当前项目下的笔记/文档条目；删除 project-files 下副本；不触动书柜原件 */
export function deleteProjectDocumentItem(itemId: number, projectId: number): void {
  const database = getDb()
  const pid = Number(projectId)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('无效项目')
  const row = database
    .prepare(
      'SELECT id, project_id, type, source_file_path FROM items WHERE id = ?'
    )
    .get(itemId) as { id: number; project_id: number | null; type: ItemRow['type']; source_file_path: string } | undefined
  if (!row) throw new Error('条目不存在')
  if (row.project_id !== pid) throw new Error('该条目不属于当前项目')

  const sp = row.source_file_path?.trim()
  if (sp && (row.type === 'file' || row.type === 'document')) {
    try {
      const ud = resolve(app.getPath('userData'))
      const abs = resolve(sp)
      const prefix = ud + sep
      const safe = abs === ud || abs.startsWith(prefix)
      if (safe && existsSync(abs)) {
        unlinkSync(abs)
      }
    } catch {
      /* 忽略单文件删除失败，仍删除库记录 */
    }
  }

  database.prepare('DELETE FROM node_relations WHERE source_id = ? OR target_id = ?').run(itemId, itemId)
  database.prepare('DELETE FROM node_tags WHERE node_id = ?').run(itemId)
  database.prepare('DELETE FROM items WHERE id = ?').run(itemId)
}

/** 批量删除项目文档（同 deleteProjectDocumentItem 规则） */
export function deleteProjectDocumentItems(itemIds: number[], projectId: number): { ok: number; failed: number } {
  const pid = Number(projectId)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('无效项目')
  const uniq = [...new Set(itemIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
  let ok = 0
  let failed = 0
  for (const id of uniq) {
    try {
      deleteProjectDocumentItem(id, pid)
      ok++
    } catch {
      failed++
    }
  }
  return { ok, failed }
}

export function copyBookshelfItemsToProject(itemIds: number[], projectId: number): number[] {
  const database = getDb()
  const pid = Number(projectId)
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('无效项目')

  const projectDir = join(app.getPath('userData'), 'project-files', String(pid))
  mkdirSync(projectDir, { recursive: true })

  const inserted: number[] = []
  const notebookId = getDefaultNotebookId()

  for (const rawId of itemIds) {
    const id = Number(rawId)
    if (!Number.isFinite(id)) continue
    const row = database
      .prepare(
        `SELECT id, notebook_id, project_id, type, title, content_text, content_json, source_file_path
         FROM items WHERE id = ?`
      )
      .get(id) as
      | {
          id: number
          notebook_id: number
          project_id: number | null
          type: ItemRow['type']
          title: string
          content_text: string
          content_json: string
          source_file_path: string
        }
      | undefined
    if (!row || row.project_id != null) continue
    if (row.type !== 'note' && row.type !== 'file' && row.type !== 'document') continue

    if (row.type === 'note') {
      const newId = insertNoteItem({
        notebookId,
        projectId: pid,
        title: row.title,
        contentText: row.content_text?.trim() ? row.content_text : '<p><br></p>',
        tags: []
      })
      const tagRows = database.prepare('SELECT tag_id FROM node_tags WHERE node_id = ?').all(id) as Array<{ tag_id: number }>
      for (const t of tagRows) {
        database.prepare('INSERT OR IGNORE INTO node_tags (node_id, tag_id) VALUES (?, ?)').run(newId, t.tag_id)
      }
      mergeItemContentJson(database, newId, { dnCopiedFromBookshelf: true, dnSourceBookshelfItemId: id })
      inserted.push(newId)
      continue
    }

    const src = row.source_file_path?.trim()
    if (!src) continue
    const dest = join(projectDir, `${Date.now()}-${basename(src)}`)
    try {
      copyFileSync(src, dest)
    } catch {
      continue
    }

    if (row.type === 'document') {
      let docKind = 'word'
      try {
        const p = JSON.parse(row.content_json || '{}') as { dnDocKind?: string }
        if (typeof p.dnDocKind === 'string' && p.dnDocKind.trim()) docKind = p.dnDocKind.trim()
      } catch {
        /* keep default */
      }
      const nid = insertDocumentItem({
        notebookId,
        projectId: pid,
        sourceFilePath: dest,
        contentText: row.content_text || '',
        docKind
      })
      mergeItemContentJson(database, nid, { dnCopiedFromBookshelf: true, dnSourceBookshelfItemId: id })
      inserted.push(nid)
      continue
    }

    let ext = ''
    let title = row.title.trim()
    try {
      const meta = JSON.parse(row.content_json || '{}') as { extension?: string; title?: string }
      if (typeof meta.extension === 'string') ext = meta.extension
      if (typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
    } catch {
      /* ignore */
    }
    if (!title) title = basename(dest)
    const aid = insertAssetItem({
      notebookId,
      projectId: pid,
      title,
      sourceFilePath: dest,
      originalFilePath: src,
      extension: ext || extname(dest)
    })
    mergeItemContentJson(database, aid, { dnCopiedFromBookshelf: true, dnSourceBookshelfItemId: id })
    inserted.push(aid)
  }

  return inserted
}

export function clearItemsForRetest(projectId?: number): void {
  const database = getDb()
  if (Number.isFinite(projectId)) {
    const ids = database.prepare('SELECT id FROM items WHERE project_id = ?').all(projectId) as Array<{ id: number }>
    for (const row of ids) {
      database.prepare('DELETE FROM node_relations WHERE source_id = ? OR target_id = ?').run(row.id, row.id)
      database.prepare('DELETE FROM node_tags WHERE node_id = ?').run(row.id)
    }
    database.prepare('DELETE FROM items WHERE project_id = ?').run(projectId)
    return
  }
  database.exec('DELETE FROM items;')
  database.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run('items')
}

export type TagRow = {
  id: number
  name: string
  color: string
}

export function getAllTags(projectId?: number, bookshelfOnly?: boolean): TagRow[] {
  const database = getDb()
  if (bookshelfOnly) {
    const rows = database
      .prepare(
        `
      SELECT DISTINCT t.id, t.name, t.color
      FROM tags t
      INNER JOIN node_tags nt ON nt.tag_id = t.id
      INNER JOIN items i ON i.id = nt.node_id
      WHERE i.project_id IS NULL
      ORDER BY t.name ASC
    `
      )
      .all() as TagRow[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color
    }))
  }

  const pid = strictListProjectId(projectId)
  if (pid == null) return []

  const rows = database
    .prepare(
      `
      SELECT DISTINCT t.id, t.name, t.color
      FROM tags t
      INNER JOIN node_tags nt ON nt.tag_id = t.id
      INNER JOIN items i ON i.id = nt.node_id
      WHERE i.project_id = @projectId
      ORDER BY t.name ASC
    `
    )
    .all({ projectId: Number(projectId) }) as TagRow[]
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color
  }))
}

export function addTagToNode(nodeId: number, tagName: string, color: string): TagRow {
  const database = getDb()
  const normalizedTag = tagName.trim()
  const normalizedColor = color?.trim() || '#3b82f6'
  if (!normalizedTag) {
    throw new Error('标签名称不能为空')
  }

  const tx = database.transaction(() => {
    const node = database.prepare('SELECT id FROM items WHERE id = ?').get(nodeId) as { id: number } | undefined
    if (!node) throw new Error(`节点不存在: ${nodeId}`)

    database
      .prepare(`
        INSERT INTO tags (name, color)
        VALUES (@name, @color)
        ON CONFLICT(name) DO UPDATE SET color = excluded.color
      `)
      .run({ name: normalizedTag, color: normalizedColor })

    const tag = database
      .prepare('SELECT id, name, color FROM tags WHERE name = ?')
      .get(normalizedTag) as TagRow | undefined
    if (!tag) throw new Error('标签创建失败')

    database.prepare('INSERT OR IGNORE INTO node_tags (node_id, tag_id) VALUES (?, ?)').run(nodeId, tag.id)
    return tag
  })

  return tx()
}

export function removeTagFromNode(nodeId: number, tagId: number): void {
  const database = getDb()
  database.prepare('DELETE FROM node_tags WHERE node_id = ? AND tag_id = ?').run(nodeId, tagId)
}

export type NodeDetailRow = ItemRow & {
  tags: TagRow[]
}

export function getNodeDetail(nodeId: number): NodeDetailRow {
  const database = getDb()
  const item = database
    .prepare(
      'SELECT id, notebook_id, project_id, type, title, content_text, content_json, source_file_path, created_at, updated_at FROM items WHERE id = ?'
    )
    .get(nodeId) as ItemRow | undefined
  if (!item) throw new Error(`节点不存在: ${nodeId}`)

  const tags = database
    .prepare(
      `
      SELECT t.id, t.name, t.color
      FROM tags t
      INNER JOIN node_tags nt ON nt.tag_id = t.id
      WHERE nt.node_id = ?
      ORDER BY t.name ASC
    `
    )
    .all(nodeId) as TagRow[]

  return { ...item, tags }
}

export function updateNodeDetail(args: {
  id: number
  title: string
  contentText: string
  tags: string[]
}): void {
  const database = getDb()
  const normalizedTitle = args.title.trim()
  const normalizedContent = args.contentText.trim()
  const normalizedTags = Array.from(
    new Set((args.tags ?? []).map((tag) => tag.trim()).filter(Boolean))
  )

  const tx = database.transaction(() => {
    const current = database
      .prepare('SELECT id, type, content_json FROM items WHERE id = ?')
      .get(args.id) as { id: number; type: ItemRow['type']; content_json: string } | undefined
    if (!current) throw new Error(`节点不存在: ${args.id}`)

    let contentJson = current.content_json || ''
    if (current.type === 'note' || current.type === 'file') {
      const parsed = (() => {
        try {
          return contentJson ? (JSON.parse(contentJson) as Record<string, unknown>) : {}
        } catch {
          return {}
        }
      })()
      contentJson = JSON.stringify({ ...parsed, title: normalizedTitle })
    }

    database
      .prepare(
        `
        UPDATE items
        SET title = @title,
            content_text = @contentText,
            content_json = @contentJson,
            tags = @tagsJson,
            updated_at = datetime('now')
        WHERE id = @id
      `
      )
      .run({
        id: args.id,
        title: normalizedTitle,
        contentText: normalizedContent,
        contentJson,
        tagsJson: JSON.stringify(normalizedTags)
      })

    database.prepare('DELETE FROM node_tags WHERE node_id = ?').run(args.id)
    for (const tagName of normalizedTags) {
      database
        .prepare(
          `
          INSERT INTO tags (name, color)
          VALUES (@name, @color)
          ON CONFLICT(name) DO NOTHING
        `
        )
        .run({ name: tagName, color: '#3b82f6' })
      const tag = database.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as
        | { id: number }
        | undefined
      if (tag) {
        database.prepare('INSERT OR IGNORE INTO node_tags (node_id, tag_id) VALUES (?, ?)').run(args.id, tag.id)
      }
    }
  })

  tx()
}

/** 书柜/笔记卡片封面，存于 content_json.dnCover（data URL 或 preset:xxx） */
export function patchItemCoverImage(itemId: number, cover: string | null): void {
  const database = getDb()
  const row = database.prepare('SELECT id, type, content_json, title FROM items WHERE id = ?').get(itemId) as
    | { id: number; type: string; content_json: string; title: string }
    | undefined
  if (!row) throw new Error(`条目不存在: ${itemId}`)
  if (row.type !== 'note') throw new Error('仅笔记支持封面')
  let parsed: Record<string, unknown> = {}
  try {
    parsed = row.content_json?.trim() ? (JSON.parse(row.content_json) as Record<string, unknown>) : {}
  } catch {
    parsed = { title: row.title || '未命名笔记' }
  }
  const c = cover?.trim() ?? ''
  if (!c) {
    delete parsed.dnCover
  } else {
    parsed.dnCover = c
  }
  if (parsed.title === undefined || parsed.title === null || String(parsed.title) === '') {
    parsed.title = row.title || '未命名笔记'
  }
  database
    .prepare(`UPDATE items SET content_json = @content_json, updated_at = datetime('now') WHERE id = @id`)
    .run({ id: itemId, content_json: JSON.stringify(parsed) })
}

export type RelationRow = {
  id: number
  source: number
  target: number
  label: string
}

export type AppSettings = {
  ai_api_key: string
  ai_base_url: string
  ai_model_name: string
  ai_system_prompt: string
  ai_temperature: string
  graph_node_size: string
  graph_edge_length: string
  graph_repulsion: string
  app_theme: string
  app_language: string
}

const DEFAULT_SETTINGS: AppSettings = {
  ai_api_key: '',
  ai_base_url: '',
  ai_model_name: 'gpt-4o-mini',
  ai_system_prompt: '',
  ai_temperature: '0.4',
  graph_node_size: '36',
  graph_edge_length: '150',
  graph_repulsion: '650',
  app_theme: 'light',
  app_language: 'zh-CN'
}

export function getAppSettings(): AppSettings {
  const database = getDb()
  const rows = database.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const settings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    if (row.key in settings) {
      settings[row.key as keyof AppSettings] = row.value || ''
    }
  }
  return settings
}

export function saveAppSettings(input: Partial<Record<keyof AppSettings, string | number>>): AppSettings {
  const database = getDb()
  const current = getAppSettings()
  const next: AppSettings = {
    ai_api_key: String(input.ai_api_key ?? current.ai_api_key),
    ai_base_url: String(input.ai_base_url ?? current.ai_base_url),
    ai_model_name: String(input.ai_model_name ?? current.ai_model_name),
    ai_system_prompt: String(input.ai_system_prompt ?? current.ai_system_prompt),
    ai_temperature: String(input.ai_temperature ?? current.ai_temperature),
    graph_node_size: String(input.graph_node_size ?? current.graph_node_size),
    graph_edge_length: String(input.graph_edge_length ?? current.graph_edge_length),
    graph_repulsion: String(input.graph_repulsion ?? current.graph_repulsion),
    app_theme: String(input.app_theme ?? current.app_theme),
    app_language: String(input.app_language ?? current.app_language)
  }

  const stmt = database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (@key, @value, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `)
  const tx = database.transaction((settings: AppSettings) => {
    for (const [key, value] of Object.entries(settings)) {
      stmt.run({ key, value: String(value ?? '').trim() })
    }
  })
  tx(next)
  return getAppSettings()
}

export type NodeSearchResult = {
  id: number
  name: string
  type: ItemRow['type']
}

export type NodeEdgeRow = RelationRow & {
  direction: 'outgoing' | 'incoming'
  otherNodeId: number
  otherNodeName: string
  otherNodeType: ItemRow['type']
}

export type AiContextNode = {
  id: number
  type: ItemRow['type']
  title: string
  contentText: string
  contentJson: string
  sourceFilePath: string
}

export type AiContextNeighbor = AiContextNode & {
  relationId: number
  relationLabel: string
  direction: 'outgoing' | 'incoming'
}

export type AiNodeContext = {
  core: AiContextNode
  neighbors: AiContextNeighbor[]
}

function getNodeDisplayName(row: { id: number; title?: string; content_text?: string }): string {
  const name = (row.title || row.content_text || '').trim()
  return name ? name.slice(0, 80) : `Node #${row.id}`
}

export function searchNodes(keyword: string, excludeId?: number, projectId?: number): NodeSearchResult[] {
  const database = getDb()
  const pid = strictListProjectId(projectId)
  if (pid == null) return []

  const normalized = keyword.trim()
  const rows = database
    .prepare(
      `
      SELECT id, type, title, content_text
      FROM items
      WHERE project_id = @projectId
        AND (@excludeId IS NULL OR id != @excludeId)
        AND (
          @q = ''
          OR title LIKE @likeQ
          OR content_text LIKE @likeQ
          OR content_json LIKE @likeQ
        )
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 30
    `
    )
    .all({
      excludeId: Number.isFinite(excludeId) ? excludeId : null,
      projectId: pid,
      q: normalized,
      likeQ: `%${normalized}%`
    }) as Array<{ id: number; type: ItemRow['type']; title: string; content_text: string }>

  return rows.map((row) => ({
    id: row.id,
    name: getNodeDisplayName(row),
    type: row.type
  }))
}

export function addRelation(sourceId: number, targetId: number, label: string): number {
  const database = getDb()
  const normalizedLabel = label?.trim() || ''

  const tx = database.transaction(() => {
    const sourceExists = database.prepare('SELECT id FROM items WHERE id = ?').get(sourceId) as
      | { id: number }
      | undefined
    const targetExists = database.prepare('SELECT id FROM items WHERE id = ?').get(targetId) as
      | { id: number }
      | undefined
    if (!sourceExists || !targetExists) throw new Error('起点或终点节点不存在')

    const result = database
      .prepare('INSERT INTO node_relations (source_id, target_id, relation_label) VALUES (?, ?, ?)')
      .run(sourceId, targetId, normalizedLabel)
    return Number(result.lastInsertRowid)
  })

  return tx()
}

export function removeRelation(relationId: number): void {
  const database = getDb()
  database.prepare('DELETE FROM node_relations WHERE id = ?').run(relationId)
}

export function getNodeEdges(nodeId: number): NodeEdgeRow[] {
  const database = getDb()
  const rows = database
    .prepare(
      `
      SELECT
        r.id,
        r.source_id AS source,
        r.target_id AS target,
        r.relation_label AS label,
        CASE WHEN r.source_id = @nodeId THEN 'outgoing' ELSE 'incoming' END AS direction,
        CASE WHEN r.source_id = @nodeId THEN target.id ELSE source.id END AS otherNodeId,
        CASE
          WHEN r.source_id = @nodeId THEN COALESCE(NULLIF(target.title, ''), NULLIF(target.content_text, ''), 'Node #' || target.id)
          ELSE COALESCE(NULLIF(source.title, ''), NULLIF(source.content_text, ''), 'Node #' || source.id)
        END AS otherNodeName,
        CASE WHEN r.source_id = @nodeId THEN target.type ELSE source.type END AS otherNodeType
      FROM node_relations r
      INNER JOIN items source ON source.id = r.source_id
      INNER JOIN items target ON target.id = r.target_id
      WHERE r.source_id = @nodeId OR r.target_id = @nodeId
      ORDER BY r.id DESC
    `
    )
    .all({ nodeId }) as NodeEdgeRow[]
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    target: row.target,
    label: row.label || '',
    direction: row.direction,
    otherNodeId: row.otherNodeId,
    otherNodeName: row.otherNodeName,
    otherNodeType: row.otherNodeType
  }))
}

export function getAiNodeContext(nodeId: number): AiNodeContext {
  const database = getDb()
  const core = database
    .prepare(
      `
      SELECT id, type, title, content_text AS contentText, content_json AS contentJson, source_file_path AS sourceFilePath
      FROM items
      WHERE id = ?
    `
    )
    .get(nodeId) as AiContextNode | undefined
  if (!core) throw new Error(`节点不存在: ${nodeId}`)

  const rows = database
    .prepare(
      `
      SELECT
        other.id,
        other.type,
        other.title,
        other.content_text AS contentText,
        other.content_json AS contentJson,
        other.source_file_path AS sourceFilePath,
        r.id AS relationId,
        r.relation_label AS relationLabel,
        CASE WHEN r.source_id = @nodeId THEN 'outgoing' ELSE 'incoming' END AS direction
      FROM node_relations r
      INNER JOIN items other ON other.id = CASE WHEN r.source_id = @nodeId THEN r.target_id ELSE r.source_id END
      WHERE r.source_id = @nodeId OR r.target_id = @nodeId
      ORDER BY r.id ASC
    `
    )
    .all({ nodeId }) as AiContextNeighbor[]

  return {
    core: {
      id: core.id,
      type: core.type,
      title: core.title || '',
      contentText: core.contentText || '',
      contentJson: core.contentJson || '',
      sourceFilePath: core.sourceFilePath || ''
    },
    neighbors: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title || '',
      contentText: row.contentText || '',
      contentJson: row.contentJson || '',
      sourceFilePath: row.sourceFilePath || '',
      relationId: row.relationId,
      relationLabel: row.relationLabel || '关联',
      direction: row.direction
    }))
  }
}

export type GraphNode = {
  id: number
  name: string
  type: ItemRow['type']
  tags: TagRow[]
  x: number | null
  y: number | null
}

export type GraphEdge = RelationRow

export type GraphData = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type GraphFilterInput = {
  types?: string[]
  tags?: string[]
  projectId?: number
  /** 仅书柜：project_id IS NULL 的节点与边 */
  bookshelfOnly?: boolean
}

export type NodePositionInput = {
  id: number
  x: number
  y: number
}

export function updateNodePositions(positions: NodePositionInput[]): number {
  const database = getDb()
  const validPositions = positions.filter(
    (position) =>
      Number.isFinite(position.id) && Number.isFinite(position.x) && Number.isFinite(position.y)
  )
  if (validPositions.length === 0) return 0

  const stmt = database.prepare('UPDATE items SET x = @x, y = @y, updated_at = datetime(\'now\') WHERE id = @id')
  const tx = database.transaction((payload: NodePositionInput[]) => {
    for (const position of payload) stmt.run(position)
  })
  tx(validPositions)
  return validPositions.length
}

function filterGraphData(graph: GraphData, filters: GraphFilterInput = {}): GraphData {
  const typeSet = new Set((filters.types ?? []).filter(Boolean))
  const tagSet = new Set((filters.tags ?? []).filter(Boolean))
  const nodes = graph.nodes.filter((node) => {
    const typeMatched = typeSet.size === 0 || typeSet.has(node.type)
    const tagMatched = tagSet.size === 0 || node.tags.some((tag) => tagSet.has(tag.name))
    return typeMatched && tagMatched
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  }
}

export function getGraphData(filters: GraphFilterInput = {}): GraphData {
  const database = getDb()
  const bookshelfOnly = Boolean(filters.bookshelfOnly)
  const strictPid = strictListProjectId(filters.projectId)

  if (!bookshelfOnly && strictPid == null) {
    return filterGraphData({ nodes: [], edges: [] }, filters)
  }

  const projectId = bookshelfOnly ? null : strictPid

  const nodeRows = database
    .prepare(`
    SELECT
      i.id AS node_id,
      i.type AS node_type,
      i.title AS node_title,
      i.content_text AS content_text,
      i.x AS x,
      i.y AS y,
      t.id AS tag_id,
      t.name AS tag_name,
      t.color AS tag_color
    FROM items i
    LEFT JOIN node_tags nt ON nt.node_id = i.id
    LEFT JOIN tags t ON t.id = nt.tag_id
    WHERE
      (@bookshelfOnly = 1 AND i.project_id IS NULL)
      OR (@bookshelfOnly = 0 AND i.project_id = @projectId)
    ORDER BY i.id ASC
  `)
    .all({
      projectId,
      bookshelfOnly: bookshelfOnly ? 1 : 0
    }) as Array<{
    node_id: number
    node_type: ItemRow['type']
    node_title: string
    content_text: string
    x: number | null
    y: number | null
    tag_id: number | null
    tag_name: string | null
    tag_color: string | null
  }>

  const nodeMap = new Map<number, GraphNode>()
  for (const row of nodeRows) {
    if (!nodeMap.has(row.node_id)) {
      const baseName = (row.node_title || row.content_text || '').trim()
      nodeMap.set(row.node_id, {
        id: row.node_id,
        name: baseName ? baseName.slice(0, 48) : `Node #${row.node_id}`,
        type: row.node_type,
        tags: [],
        x: row.x,
        y: row.y
      })
    }
    if (row.tag_id && row.tag_name && row.tag_color) {
      nodeMap.get(row.node_id)?.tags.push({
        id: row.tag_id,
        name: row.tag_name,
        color: row.tag_color
      })
    }
  }

  const edgeRows = database
    .prepare(`
    SELECT r.id, r.source_id AS source, r.target_id AS target, r.relation_label AS label
    FROM node_relations r
    INNER JOIN items source ON source.id = r.source_id
    INNER JOIN items target ON target.id = r.target_id
    WHERE
      (@bookshelfOnly = 1 AND source.project_id IS NULL AND target.project_id IS NULL)
      OR (@bookshelfOnly = 0 AND source.project_id = @projectId AND target.project_id = @projectId)
    ORDER BY r.id ASC
  `)
    .all({ projectId, bookshelfOnly: bookshelfOnly ? 1 : 0 }) as GraphEdge[]
  const edges = edgeRows.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label || ''
  }))

  return filterGraphData({
    nodes: Array.from(nodeMap.values()),
    edges
  }, filters)
}

export function getLocalGraphData(nodeId: number, depth = 1, projectId?: number, bookshelfOnly?: boolean): GraphData {
  const graph = getGraphData({ projectId, bookshelfOnly: Boolean(bookshelfOnly) })
  const maxDepth = Math.max(1, Math.min(Number.isFinite(depth) ? Math.floor(depth) : 1, 4))
  const adjacency = new Map<number, number[]>()
  for (const edge of graph.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge.source])
  }

  const visited = new Set<number>([nodeId])
  const queue: Array<{ id: number; distance: number }> = [{ id: nodeId, distance: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || current.distance >= maxDepth) continue
    for (const nextId of adjacency.get(current.id) ?? []) {
      if (visited.has(nextId)) continue
      visited.add(nextId)
      queue.push({ id: nextId, distance: current.distance + 1 })
    }
  }

  return {
    nodes: graph.nodes.filter((node) => visited.has(node.id)),
    edges: graph.edges.filter((edge) => visited.has(edge.source) && visited.has(edge.target))
  }
}
