import { ensureValidCopilotToken } from '../auth/copilot-token.js'
import { copilotHeaders } from './headers.js'

/** 默认 Copilot Chat Completions endpoint（可被 auth.endpoints.api 覆盖） */
const DEFAULT_API_BASE = 'https://api.githubcopilot.com'

/**
 * 调用 Copilot Chat Completions
 * - body：标准 OpenAI Chat Completions 请求体（已经被 transform/request.ts 转好）
 * - 返回原始 Response 对象，保留 stream 给上层处理（流式 / 非流式都用）
 *
 * 出错时抛异常，上层 hono route 统一捕获
 */
export async function callCopilotChat(body: Record<string, unknown>): Promise<Response> {
  const auth = await ensureValidCopilotToken()

  // 优先用 Copilot 返回的 endpoints.api，否则用默认
  const apiBase = auth.endpoints?.api ?? DEFAULT_API_BASE
  const url = `${apiBase}/chat/completions`

  const res = await fetch(url, {
    method: 'POST',
    headers: copilotHeaders(auth.copilot_token),
    body: JSON.stringify(body),
  })

  // 非流式 + 错误：把 body 读出来塞到错误信息里，方便上层报错
  if (!res.ok && !body.stream) {
    const errText = await res.text()
    throw new Error(`Copilot API 错误：HTTP ${res.status} ${errText}`)
  }

  return res
}
