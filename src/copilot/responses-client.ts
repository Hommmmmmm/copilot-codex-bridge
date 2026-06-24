import { ensureValidCopilotToken } from '../auth/copilot-token.js'
import { copilotHeaders } from './headers.js'

/** 默认 Copilot endpoint */
const DEFAULT_API_BASE = 'https://api.githubcopilot.com'

/**
 * 直接透传 Responses API 请求到 Copilot 的 /responses endpoint
 * Copilot 的新模型（gpt-5.x、claude、gemini、codex 等）只支持 /responses，不支持 /chat/completions
 *
 * 注意：Copilot 的 /responses endpoint 返回格式跟 OpenAI 官方 Responses 完全一致，
 * 所以代理是真正的透传——请求和响应都不做转换，直接转发
 *
 * 返回原始 Response（含 stream body），上层 hono route 透传给 Codex
 */
export async function callCopilotResponses(body: Record<string, unknown>): Promise<Response> {
  const auth = await ensureValidCopilotToken()
  const apiBase = auth.endpoints?.api ?? DEFAULT_API_BASE
  const url = `${apiBase}/responses`

  const res = await fetch(url, {
    method: 'POST',
    headers: copilotHeaders(auth.copilot_token),
    body: JSON.stringify(body),
  })

  // 非流式请求时如果上游报错，让上层抛错（流式时让 stream 自己处理）
  if (!res.ok && !body.stream) {
    const errText = await res.text()
    throw new Error(`Copilot /responses API 错误：HTTP ${res.status} ${errText}`)
  }

  return res
}
