import OpenAI from 'openai'
import { getAiNodeContext, getAppSettings, type AiContextNeighbor, type AiContextNode } from './db'

export type AiChatMessage = {
  role: 'user' | 'assistant'
  content: string
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

export async function chatWithKnowledgeBase(messages: AiChatMessage[], contextNodeId?: number): Promise<string> {
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

  let contextPrompt = '当前没有选中的图谱节点。你可以回答通用知识库使用问题；涉及具体数据时，请说明需要先选择节点或等待后续 RAG 检索能力。'
  if (contextNodeId && Number.isFinite(contextNodeId)) {
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

  const completion = await client.chat.completions.create({
    model: config.model,
    temperature: config.temperature,
    messages: [
      {
        role: 'system',
        content: `${config.systemPrompt || '你是 DataNode 的全局知识库 AI 助手。请用中文回答，简洁、结构清晰，基于已提供的上下文，不要编造未出现的数据。'}

${contextPrompt}`
      },
      ...safeMessages
    ]
  })

  const content = completion.choices[0]?.message?.content?.trim()
  if (!content) throw new Error('AI 未返回有效内容')
  return content
}
