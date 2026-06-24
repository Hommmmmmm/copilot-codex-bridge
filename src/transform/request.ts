import { toolsResponsesToChat, type ResponsesToolDef } from './tools.js'

/**
 * 把 OpenAI Responses 格式的请求体转成 OpenAI Chat Completions 格式
 * 这是请求方向的转换器，下游会把 Chat Completions 直接发给 Copilot
 *
 * Responses 请求关键字段：
 *   - input: string | InputItem[]
 *   - instructions: string  → 作为 system message
 *   - tools: ResponsesToolDef[]
 *   - tool_choice
 *   - stream, model, temperature, top_p, max_output_tokens
 *   - 忽略：previous_response_id, store, reasoning, include
 */

/** Responses 请求里的 input item（最常见的几种） */
type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system' | 'developer'; content: ContentPart[] | string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; id?: string; summary?: unknown[]; encrypted_content?: string }

type ContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string }

/** Chat Completions 的 message */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface ResponsesRequest {
  model: string
  input?: string | ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesToolDef[]
  tool_choice?: unknown
  stream?: boolean
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  parallel_tool_calls?: boolean
  // 我们忽略但要透传 model 的字段：
  previous_response_id?: string
  store?: boolean
  reasoning?: unknown
  include?: string[]
}

export interface ChatCompletionsRequest {
  model: string
  messages: ChatMessage[]
  tools?: ReturnType<typeof toolsResponsesToChat>
  tool_choice?: unknown
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  parallel_tool_calls?: boolean
}

/**
 * 主转换函数
 */
export function transformRequest(req: ResponsesRequest): ChatCompletionsRequest {
  const messages: ChatMessage[] = []

  // instructions 永远是第一条 system message
  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions })
  }

  // input 可能是字符串（最简单：单个 user message）也可能是 item 数组
  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input })
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      const converted = convertInputItem(item)
      if (converted) messages.push(converted)
    }
  }

  // 合并相邻的 assistant tool_calls：Responses 把每个 function_call 拆成独立 item，
  // 而 Chat Completions 期望一个 assistant message 带多个 tool_calls
  const merged = mergeAssistantToolCalls(messages)

  return {
    model: req.model,
    messages: merged,
    tools: toolsResponsesToChat(req.tools),
    tool_choice: req.tool_choice,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_output_tokens,
    parallel_tool_calls: req.parallel_tool_calls,
  }
}

/** 把单个 Responses input item 转成 Chat message（可能返回 null 表示丢弃） */
function convertInputItem(item: ResponsesInputItem): ChatMessage | null {
  switch (item.type) {
    case 'message': {
      // role 'developer' 在 Chat 里映射成 system
      const role = item.role === 'developer' ? 'system' : item.role
      const content = flattenContent(item.content)
      return { role, content }
    }
    case 'function_call': {
      // assistant 触发的工具调用：在 Chat 里要包成 assistant message + tool_calls 数组
      // 这里先单独建一个，后面 mergeAssistantToolCalls 会合并相邻的
      return {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      }
    }
    case 'function_call_output': {
      // 工具结果：Chat 里是独立的 role:"tool" message
      return {
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output,
      }
    }
    case 'reasoning': {
      // Codex 会把上一轮 reasoning 塞回来，Copilot 不消费，直接丢弃
      return null
    }
    default:
      return null
  }
}

/** 把 Responses 的 content parts 数组转成 Chat 的 content（字符串或多模态数组） */
function flattenContent(content: ContentPart[] | string): ChatMessage['content'] {
  if (typeof content === 'string') return content

  // 全是文本：合并成单字符串
  const allText = content.every((p) => p.type === 'input_text' || p.type === 'output_text')
  if (allText) {
    return content.map((p) => (p as { text: string }).text).join('')
  }

  // 含图片：转 Chat 的多模态格式
  return content.map((p) => {
    if (p.type === 'input_text' || p.type === 'output_text') {
      return { type: 'text' as const, text: p.text }
    }
    return { type: 'image_url' as const, image_url: { url: p.image_url } }
  })
}

/**
 * Responses 把每个 function_call 当作独立 output item，
 * 但 Chat Completions 的协议是一个 assistant message 携带 tool_calls 数组（n 个并行调用）。
 * 这里把相邻的 assistant+tool_calls 合并。
 */
function mergeAssistantToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  for (const msg of messages) {
    const last = result[result.length - 1]
    if (
      last &&
      last.role === 'assistant' &&
      last.content === null &&
      last.tool_calls &&
      msg.role === 'assistant' &&
      msg.content === null &&
      msg.tool_calls
    ) {
      last.tool_calls.push(...msg.tool_calls)
    } else {
      result.push(msg)
    }
  }
  return result
}
