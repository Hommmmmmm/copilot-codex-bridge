import type { Context } from 'hono'
import { callCopilotChat } from '../copilot/client.js'
import { callCopilotResponses } from '../copilot/responses-client.js'
import { transformRequest, type ResponsesRequest } from '../transform/request.js'
import { transformResponse } from '../transform/response.js'
import { streamCopilotToResponses } from '../transform/sse.js'

/**
 * 哪些 model 必须走 Copilot 的 /responses endpoint（原生 Responses）
 * Copilot 把模型分两套接口：
 *   - gpt-5.x / gpt-5-codex / o-series 等新模型 → /responses（不支持 /chat/completions）
 *   - Claude / Gemini / gpt-4.x 等            → /chat/completions（不支持 /responses）
 *
 * 我们靠 model 前缀分流。走 /responses 时纯透传（不转换协议），更快更稳。
 */
function isResponsesNativeModel(model: string): boolean {
  // OpenAI 新一代：gpt-5.x、gpt-5-codex、o-series（o1/o3 等）
  return /^(gpt-5|o[1-9])/i.test(model)
}

/**
 * POST /v1/responses
 *
 * 双路径：
 * - 模型支持 /responses（gpt-5.x 等）：纯透传，原始请求/响应不做转换
 * - 模型只支持 /chat/completions（claude/gemini 等）：转换 Responses ↔ Chat Completions
 */
export async function responsesRoute(c: Context): Promise<Response> {
  const reqBody = (await c.req.json()) as ResponsesRequest
  const wantStream = reqBody.stream === true

  // 路径 1：透传到 Copilot /responses
  if (isResponsesNativeModel(reqBody.model)) {
    const copilotRes = await callCopilotResponses(reqBody as unknown as Record<string, unknown>)

    if (!wantStream) {
      // 非流式：直接转发 JSON
      const json = await copilotRes.json()
      return c.json(json as Record<string, unknown>)
    }

    // 流式：直接转发 SSE 流，不做任何转换
    if (!copilotRes.body) {
      throw new Error('Copilot /responses 流式响应缺少 body')
    }
    return new Response(copilotRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  // 路径 2：Responses ↔ Chat Completions 转换
  const chatReq = transformRequest(reqBody)
  chatReq.stream = wantStream

  const copilotRes = await callCopilotChat(chatReq as unknown as Record<string, unknown>)

  if (!wantStream) {
    const chatJson = await copilotRes.json()
    const responsesJson = transformResponse(
      chatJson as Parameters<typeof transformResponse>[0],
      reqBody.model,
      reqBody.previous_response_id,
    )
    return c.json(responsesJson)
  }

  if (!copilotRes.body) {
    throw new Error('Copilot /chat/completions 流式响应缺少 body')
  }

  const sseStream = streamCopilotToResponses(copilotRes.body, reqBody.model)
  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
