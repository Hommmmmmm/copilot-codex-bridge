import { ensureValidCopilotToken } from '../auth/copilot-token.js'
import { copilotHeaders } from './headers.js'

/** Copilot /models endpoint 返回的单个 model 项 */
export interface CopilotModel {
  id: string
  name?: string
  vendor?: string
  version?: string
  preview?: boolean
  model_picker_enabled?: boolean
  /** "powerful" / "versatile" / "lightweight" 等 */
  model_picker_category?: string
  capabilities?: {
    family?: string
    type?: string
    object?: string
    tokenizer?: string
    supports?: {
      streaming?: boolean
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      vision?: boolean
      structured_outputs?: boolean
      reasoning_effort?: string[]
    }
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
      max_non_streaming_output_tokens?: number
    }
  }
  /** "/v1/messages" / "/chat/completions" 等 */
  supported_endpoints?: string[]
}

interface ModelsResponse {
  data: CopilotModel[]
}

/**
 * 拉取 Copilot 当前账号可用的模型列表
 * 用途：暴露给 /v1/models endpoint 让 Codex CLI 看到可选模型
 */
export async function listCopilotModels(): Promise<CopilotModel[]> {
  const auth = await ensureValidCopilotToken()
  const apiBase = auth.endpoints?.api ?? 'https://api.githubcopilot.com'

  const res = await fetch(`${apiBase}/models`, {
    method: 'GET',
    headers: copilotHeaders(auth.copilot_token),
  })

  if (!res.ok) {
    throw new Error(`拉取 Copilot 模型列表失败：HTTP ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as ModelsResponse
  return body.data ?? []
}

/**
 * 过滤出适合 Codex 桌面端模型选择器展示的模型
 * 规则：
 * - capabilities.type === 'chat'（排除 embedding）
 * - supports.tool_calls === true（Codex 需要工具调用）
 * - model_picker_enabled !== false（Copilot 自己已经隐藏的不显示）
 * - 排除内部工具模型如 trajectory-compaction
 */
export function filterUsableChatModels(models: CopilotModel[]): CopilotModel[] {
  const internalIds = new Set(['trajectory-compaction'])
  return models.filter((m) => {
    if (internalIds.has(m.id)) return false
    if (m.capabilities?.type && m.capabilities.type !== 'chat') return false
    if (!m.capabilities?.supports?.tool_calls) return false
    if (m.model_picker_enabled === false) return false
    return true
  })
}
