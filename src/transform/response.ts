import { randomUUID } from 'node:crypto'

/**
 * 把 Chat Completions 的非流式响应升维成 Responses 格式
 *
 * Chat: {choices:[{message:{content, tool_calls}}], usage}
 * Responses: {id, output:[message_item, function_call_item, ...], usage}
 */

interface ChatCompletionsResponse {
  id?: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  id: string
  status?: 'completed' | 'in_progress'
  // message item
  role?: 'assistant'
  content?: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>
  // function_call item
  call_id?: string
  name?: string
  arguments?: string
}

export interface ResponsesResponse {
  id: string
  object: 'response'
  created_at: number
  status: 'completed' | 'failed' | 'in_progress'
  model: string
  output: ResponsesOutputItem[]
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  // 透传字段
  parallel_tool_calls?: boolean
  previous_response_id?: string | null
  metadata?: Record<string, string>
}

export function transformResponse(
  chat: ChatCompletionsResponse,
  model: string,
  previousResponseId?: string | null,
): ResponsesResponse {
  const choice = chat.choices[0]
  const output: ResponsesOutputItem[] = []

  // 有文本内容 → 一个 message item
  if (choice?.message.content) {
    output.push({
      type: 'message',
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: choice.message.content,
          annotations: [],
        },
      ],
    })
  }

  // 每个 tool_call → 一个独立的 function_call item
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        id: `fc_${randomUUID().replace(/-/g, '')}`,
        status: 'completed',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  return {
    id: `resp_${randomUUID().replace(/-/g, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: chat.usage
      ? {
          input_tokens: chat.usage.prompt_tokens,
          output_tokens: chat.usage.completion_tokens,
          total_tokens: chat.usage.total_tokens,
        }
      : undefined,
    previous_response_id: previousResponseId ?? null,
  }
}
