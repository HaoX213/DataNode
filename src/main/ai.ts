import OpenAI from 'openai'
import {
  countExcelRowsForStats,
  getAiNodeContext,
  getAppSettings,
  getExcelStructuredRowsForStats,
  getMergedExcelStructuredRowsForProjects,
  listProjects,
  type AiContextNeighbor,
  type AiContextNode
} from './db'
import {
  inferAllFields,
  inferNumericFields,
  statsAverage,
  statsMax,
  statsMin,
  statsSum,
  statsUniqueValues
} from './stats-engine'

export type AiChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type AiChatOptions = {
  projectId?: number | null
  /** 全局 AI：不向模型注入项目/库内统计，也不用图谱节点上下文 */
  globalAi?: boolean
  /** 全局 AI：勾选的要并入统计上下文的项目 id（跨项目分析） */
  linkedProjectIds?: number[]
  rawFilePreview?: string
  rawFilePath?: string
}

type AiConfig = {
  apiKey: string
  baseURL: string
  model: string
  systemPrompt: string
  temperature: number
}

function getAiConfig(): AiConfig {
  const settings = getAppSettings()
  const apiKey = settings.ai_api_key.trim()
  if (!apiKey) {
    throw new Error('请先在设置中配置 API Key')
  }

  return {
    apiKey,
    baseURL: settings.ai_base_url.trim(),
    model: settings.ai_model_name.trim() || 'gpt-4o-mini',
    systemPrompt: settings.ai_system_prompt.trim(),
    temperature: Math.max(0, Math.min(Number(settings.ai_temperature) || 0.4, 2))
  }
}

function compactJson(input: string): string {
  if (!input?.trim()) return ''
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

function describeNode(node: AiContextNode): string {
  const jsonText = compactJson(node.contentJson)
  return [
    `ID: ${node.id}`,
    `类型: ${node.type}`,
    `标题: ${node.title || '未命名'}`,
    `正文: ${(node.contentText || '').slice(0, 2500) || '无'}`,
    jsonText ? `结构化数据: ${jsonText.slice(0, 2500)}` : '',
    node.sourceFilePath ? `来源文件: ${node.sourceFilePath}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function describeNeighbor(node: AiContextNeighbor, index: number): string {
  const relation = node.direction === 'outgoing' ? `核心节点 --${node.relationLabel}--> 该节点` : `该节点 --${node.relationLabel}--> 核心节点`
  return [`关联节点 ${index + 1}`, `关系: ${relation}`, describeNode(node)].join('\n')
}

export async function summarizeNodeContext(nodeId: number): Promise<string> {
  const config = getAiConfig()
  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {})
  })
  const context = getAiNodeContext(nodeId)
  const neighborText = context.neighbors.length
    ? context.neighbors.map(describeNeighbor).join('\n\n---\n\n')
    : '暂无直接关联节点。'

  const completion = await client.chat.completions.create({
    model: config.model,
    temperature: config.temperature,
    messages: [
      {
        role: 'system',
        content:
          config.systemPrompt ||
          '你是 DataNode 的知识库助手。请只基于用户提供的节点与一度关联上下文进行分析，不要编造未出现的信息。'
      },
      {
        role: 'user',
        content: `请根据以下知识图谱上下文，输出中文结构化总结，包含：
1. 核心节点在讲什么
2. 与周边节点的关键关系
3. 可以继续追问或补充的信息

【核心节点】
${describeNode(context.core)}

【一度关联节点】
${neighborText}`
      }
    ]
  })

  const content = completion.choices[0]?.message?.content?.trim()
  if (!content) throw new Error('AI 未返回有效内容')
  return content
}

function buildAutoStatsSummary(projectId?: number): string {
  const totalRows = countExcelRowsForStats(projectId)
  if (totalRows === 0) {
    return '（当前项目暂无 excel_row 结构化数据行；可先导入 Excel/CSV/JSON）'
  }
  const rows = getExcelStructuredRowsForStats(projectId, 15000)
  if (rows.length === 0) {
    return `数据库中标记为 excel_row 共 ${totalRows} 行，但未能解析出有效 JSON 字段（请检查导入数据）。`
  }
  const nf = inferNumericFields(rows).slice(0, 8)
  const allf = inferAllFields(rows).slice(0, 35)
  const lines: string[] = [
    `结构化行数（用于摘要计算，最多加载 ${rows.length} 行）: ${rows.length}`,
    `字段列表: ${allf.join(', ')}`
  ]
  for (const f of nf) {
    const avg = statsAverage(rows, f)
    lines.push(
      `${f}: 合计=${statsSum(rows, f)} 平均=${avg === null ? '-' : avg.toFixed(4)} 最大=${statsMax(rows, f) ?? '-'} 最小=${statsMin(rows, f) ?? '-'}`
    )
  }
  const cats = allf.filter((f) => !nf.includes(f)).slice(0, 6)
  for (const f of cats) {
    const uv = statsUniqueValues(rows, f, 10)
    if (uv.length > 0 && uv.length <= 25) {
      lines.push(`${f} 取值分布(前10): ` + uv.map((u) => `${u.value}×${u.count}`).join(', '))
    }
  }
  return lines.join('\n')
}

function stripMetaFields(keys: string[]): string[] {
  return keys.filter((k) => !k.startsWith('_DataNode'))
}

function buildMultiProjectStatsSummary(projectIds: number[]): string {
  const ids = [...new Set(projectIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (ids.length === 0) return '（关联项目列表为空。）'
  const projects = listProjects().filter((p) => ids.includes(p.id))
  const nameById = new Map(projects.map((p) => [p.id, p.name]))
  const lines: string[] = [
    `关联项目：${ids.map((id) => `${nameById.get(id) ?? `项目${id}`}(id=${id})`).join('、')}`,
    '合并样本中每行带有系统字段 _DataNodeProjectId（来源项目 id），可按项目拆分或对比。'
  ]
  const merged = getMergedExcelStructuredRowsForProjects(ids, 12000)
  if (merged.length === 0) {
    for (const id of ids) {
      const c = countExcelRowsForStats(id)
      lines.push(`— ${nameById.get(id) ?? id}：excel_row 行数约 ${c}（可解析为结构化对象的采样为 0）`)
    }
    return lines.join('\n')
  }
  const allf = stripMetaFields(inferAllFields(merged)).slice(0, 40)
  const nf = stripMetaFields(inferNumericFields(merged)).slice(0, 10)
  lines.push(`合并采样行数: ${merged.length}`)
  const counts = new Map<number, number>()
  for (const row of merged) {
    const raw = row._DataNodeProjectId
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n)) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  for (const id of ids) {
    lines.push(`  — 样本中来自 ${nameById.get(id) ?? id}(id=${id})：${counts.get(id) ?? 0} 行`)
  }
  lines.push(`字段列表（已排除 _DataNode 系统前缀）: ${allf.join(', ') || '—'}`)
  for (const f of nf) {
    const avg = statsAverage(merged, f)
    lines.push(
      `${f}: 合计=${statsSum(merged, f)} 平均=${avg === null ? '-' : avg.toFixed(4)} 最大=${statsMax(merged, f) ?? '-'} 最小=${statsMin(merged, f) ?? '-'}`
    )
  }
  const cats = allf.filter((f) => !nf.includes(f)).slice(0, 6)
  for (const f of cats) {
    const uv = statsUniqueValues(merged, f, 10)
    if (uv.length > 0 && uv.length <= 25) {
      lines.push(`${f} 取值分布(前10): ` + uv.map((u) => `${u.value}×${u.count}`).join(', '))
    }
  }
  return lines.join('\n')
}

export async function chatWithKnowledgeBase(
  messages: AiChatMessage[],
  contextNodeId?: number,
  options?: AiChatOptions
): Promise<string> {
  const config = getAiConfig()
  const client = new OpenAI({
    apiKey: config.apiKey.trim(),
    ...(config.baseURL ? { baseURL: config.baseURL.trim() } : {})
  })

  const safeMessages = messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content?.trim())
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 6000)
    }))
  if (safeMessages.length === 0) throw new Error('消息不能为空')

  const isGlobal = Boolean(options?.globalAi)
  const linkedIds =
    isGlobal && Array.isArray(options?.linkedProjectIds) && options.linkedProjectIds.length > 0
      ? [...new Set(options.linkedProjectIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))]
      : []

  const statsProjectId: number | undefined =
    !isGlobal &&
    options?.projectId !== undefined &&
    options?.projectId !== null &&
    Number.isFinite(Number(options.projectId))
      ? Number(options.projectId)
      : undefined

  const dataStatsBlock = isGlobal
    ? linkedIds.length > 0
      ? buildMultiProjectStatsSummary(linkedIds)
      : '（全局 AI：未勾选「关联项目」时不注入项目表格统计；可在左侧勾选项目以进行跨项目对比、汇总与趋势分析。）'
    : buildAutoStatsSummary(statsProjectId)
  let rawFileBlock = ''
  if (!isGlobal && options?.rawFilePreview?.trim()) {
    const prev = options.rawFilePreview.trim()
    rawFileBlock = `

【用户刚选择的纯／非表格文本文件（供你理解结构与拆分字段；路径：${options.rawFilePath ?? '未知'}）】
${prev.slice(0, 10000)}${prev.length > 10000 ? '\n…(已截断)' : ''}

当用户希望「写入数据库」时，请输出**一段**可被解析的 JSON 数组（每元素为扁平对象），并用 markdown 代码块标记为 json，例如：
\`\`\`json
[{"列1":"值","列2":"123"}]
\`\`\`
用户可使用对话框中的「应用 AI 建议 JSON 入库」将数组写入当前项目。`
  }

  const chartHint = `

【图表】若适合可视化，在正文之后**另起一行**输出（不要用代码块包裹整段 JSON）：
CHART_JSON:{"type":"bar"|"line"|"pie","title":"标题","categories":["类别"],"values":[1,2]}
饼图可省略 categories，使用 "names" 与 "values"。`

  let contextPrompt = '当前没有选中的图谱节点。你可以回答通用知识库使用问题；涉及具体数据时，请说明需要先选择节点或等待后续 RAG 检索能力。'
  if (!isGlobal && contextNodeId && Number.isFinite(contextNodeId)) {
    const context = getAiNodeContext(contextNodeId)
    const neighborText = context.neighbors.length
      ? context.neighbors.slice(0, 8).map(describeNeighbor).join('\n\n---\n\n')
      : '暂无直接关联节点。'
    contextPrompt = `当前用户选中的上下文节点如下。回答时优先结合该节点和一度关联节点；如果信息不足，请明确说明。

【当前选中节点】
${describeNode(context.core)}

【一度关联节点】
${neighborText}`
  }

  const statsSectionLabel = isGlobal
    ? linkedIds.length > 0
      ? '【跨项目结构化数据 — 程序预计算摘要（统计类问题请优先引用此处数字）】'
      : '【上下文说明】'
    : '【当前项目结构化数据 — 程序预计算摘要（统计类问题请优先引用此处数字）】'

  const completion = await client.chat.completions.create({
    model: config.model,
    temperature: config.temperature,
    messages: [
      {
        role: 'system',
        content: `${config.systemPrompt || '你是 DataNode 的全局知识库与数据分析 AI 助手。请用中文回答，简洁、结构清晰，基于已提供的上下文与**程序预计算摘要**，不要编造未出现的数据。'}

${contextPrompt}

${statsSectionLabel}
${dataStatsBlock}
${rawFileBlock}
${chartHint}`
      },
      ...safeMessages
    ]
  })

  const content = completion.choices[0]?.message?.content?.trim()
  if (!content) throw new Error('AI 未返回有效内容')
  return content
}
