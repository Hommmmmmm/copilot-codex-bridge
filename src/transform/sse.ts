import { randomUUID } from 'node:crypto'

/**
 * SSE 转换器：把 Copilot 返回的 Chat Completions SSE 流转成 OpenAI Responses SSE 事件流
 *
 * Chat Completions 流的格式：
 *   data: {"id":"...","choices":[{"index":0,"delta":{"role":"assistant"}}]}
 *   data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}
 *   data: {"choices":[{"index":0,"delta":{"content":" world"}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"...","function":{"name":"f","arguments":""}}]}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\""}}]}}]}
 *   data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{...}}
 *   data: [DONE]
 *
 * Responses 流必须按这个顺序发：
 *   response.created
 *   response.in_progress
 *   [对每个 message item]
 *     response.output_item.added (item={type:message,status:in_progress})
 *     response.content_part.added (part={type:output_text,text:""})
 *     response.output_text.delta * N
 *     response.output_text.done
 *     response.content_part.done
 *     response.output_item.done
 *   [对每个 tool call]
 *     response.output_item.added (item={type:function_call,status:in_progress})
 *     response.function_call_arguments.delta * N
 *     response.function_call_arguments.done
 *     response.output_item.done
 *   response.completed (带 usage)
 *
 * 关键：所有事件携带递增的 sequence_number，不发 [DONE] 哨兵
 */

interface ChatStreamChunk {
  id?: string
  choices?: Array<{
    index: number
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface OutputState {
  messageItemId: string | null
  messageOutputIndex: number | null
  messageText: string
  messageStarted: boolean
  messageContentPartStarted: boolean

  toolCalls: Map<
    number, // chunk delta 的 tool_calls[].index
    {
      itemId: string
      callId: string
      outputIndex: number
      name: string
      argsBuffer: string
      itemStarted: boolean
    }
  >

  nextOutputIndex: number
}

/**
 * 主入口：消费 Copilot SSE → 产出 Responses SSE
 * 返回 ReadableStream<Uint8Array> 可直接传给 hono Response
 */
export function streamCopilotToResponses(
  copilotBody: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`
  const createdAt = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()

  let sequenceNumber = 0
  const state: OutputState = {
    messageItemId: null,
    messageOutputIndex: null,
    messageText: '',
    messageStarted: false,
    messageContentPartStarted: false,
    toolCalls: new Map(),
    nextOutputIndex: 0,
  }
  let lastUsage: ChatStreamChunk['usage'] | undefined
  let finishReason: string | null = null

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: Record<string, unknown>) => {
    const enriched = { ...event, sequence_number: sequenceNumber++ }
    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(enriched)}\n\n`))
  }

  const initialResponse = () => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress' as const,
    model,
    output: [] as unknown[],
    parallel_tool_calls: true,
    metadata: {},
  })

  return new ReadableStream({
    async start(controller) {
      // 1) response.created + in_progress（开场两连）
      send(controller, { type: 'response.created', response: initialResponse() })
      send(controller, { type: 'response.in_progress', response: initialResponse() })

      // 2) 消费 Copilot 流
      const reader = copilotBody.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // SSE 按 \n\n 分块，每块多行（事件类型行 + data 行）
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)

            // 取出 data: 行（可能多行 data，但 Copilot 一般单行）
            const lines = block.split('\n').filter((l) => l.startsWith('data: '))
            for (const line of lines) {
              const payload = line.slice('data: '.length).trim()
              if (payload === '[DONE]') {
                // Copilot 流结束哨兵：不直接转发，留给后面 response.completed 收尾
                continue
              }
              try {
                const chunk = JSON.parse(payload) as ChatStreamChunk
                handleChunk(chunk, controller, state, send)
                if (chunk.usage) lastUsage = chunk.usage
                const fr = chunk.choices?.[0]?.finish_reason
                if (fr) finishReason = fr
              } catch (err) {
                console.error('[sse] 解析 Copilot chunk 失败：', payload, err)
              }
            }
          }
        }
      } catch (err) {
        console.error('[sse] Copilot 流读取异常：', err)
        send(controller, {
          type: 'response.failed',
          response: { ...initialResponse(), status: 'failed' },
        })
        controller.close()
        return
      }

      // 3) 收尾：先关闭可能还开着的 message item / tool call items
      finalizeMessageItem(controller, state, send)
      finalizeToolCallItems(controller, state, send)

      // 4) 构造最终 output[] 用于 response.completed
      const finalOutput: unknown[] = []
      if (state.messageItemId) {
        finalOutput.push({
          type: 'message',
          id: state.messageItemId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: state.messageText, annotations: [] }],
        })
      }
      for (const tc of state.toolCalls.values()) {
        finalOutput.push({
          type: 'function_call',
          id: tc.itemId,
          status: 'completed',
          call_id: tc.callId,
          name: tc.name,
          arguments: tc.argsBuffer,
        })
      }

      send(controller, {
        type: 'response.completed',
        response: {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          status: 'completed',
          model,
          output: finalOutput,
          usage: lastUsage
            ? {
                input_tokens: lastUsage.prompt_tokens,
                output_tokens: lastUsage.completion_tokens,
                total_tokens: lastUsage.total_tokens,
              }
            : undefined,
          parallel_tool_calls: true,
          metadata: {},
          // 这里不发 [DONE]，response.completed 自身就是终结信号
        },
      })

      controller.close()
    },
  })
}

/**
 * 处理 Copilot 流中的一个 chunk：可能含文本 delta、工具 delta 或两者皆有
 */
function handleChunk(
  chunk: ChatStreamChunk,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: OutputState,
  send: (c: ReadableStreamDefaultController<Uint8Array>, e: Record<string, unknown>) => void,
): void {
  const choice = chunk.choices?.[0]
  if (!choice) return

  const delta = choice.delta

  // 处理文本内容
  if (delta?.content) {
    ensureMessageItemStarted(controller, state, send)
    send(controller, {
      type: 'response.output_text.delta',
      item_id: state.messageItemId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      delta: delta.content,
      logprobs: [],
    })
    state.messageText += delta.content
  }

  // 处理工具调用 delta
  if (delta?.tool_calls) {
    for (const tcDelta of delta.tool_calls) {
      const idx = tcDelta.index
      let tc = state.toolCalls.get(idx)

      // 第一次见到这个 index：建条目，先把 message 收尾（顺序：先 message done 再开 tool item）
      if (!tc) {
        finalizeMessageItem(controller, state, send)

        const itemId = `fc_${randomUUID().replace(/-/g, '')}`
        const callId = tcDelta.id ?? `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`
        const name = tcDelta.function?.name ?? ''
        tc = {
          itemId,
          callId,
          outputIndex: state.nextOutputIndex++,
          name,
          argsBuffer: '',
          itemStarted: false,
        }
        state.toolCalls.set(idx, tc)
      } else if (tcDelta.id && !tc.callId.startsWith('call_')) {
        // 如果后续 chunk 才给出 id，更新
        tc.callId = tcDelta.id
      }

      // tool name 一般在第一个 chunk 给全，但可能分片
      if (tcDelta.function?.name && !tc.name) {
        tc.name = tcDelta.function.name
      }

      // 启动 tool item（拿到 name 之后才能 emit added 事件，否则字段不完整）
      if (!tc.itemStarted && tc.name) {
        send(controller, {
          type: 'response.output_item.added',
          output_index: tc.outputIndex,
          item: {
            type: 'function_call',
            id: tc.itemId,
            status: 'in_progress',
            call_id: tc.callId,
            name: tc.name,
            arguments: '',
          },
        })
        tc.itemStarted = true
      }

      // arguments 是逐字符流式累积的
      if (tcDelta.function?.arguments && tc.itemStarted) {
        send(controller, {
          type: 'response.function_call_arguments.delta',
          item_id: tc.itemId,
          output_index: tc.outputIndex,
          delta: tcDelta.function.arguments,
        })
        tc.argsBuffer += tcDelta.function.arguments
      } else if (tcDelta.function?.arguments) {
        // tool item 还没启动就来了 args，先 buffer 起来
        tc.argsBuffer += tcDelta.function.arguments
      }
    }
  }
}

/** 第一次出现 message 内容时发 output_item.added + content_part.added */
function ensureMessageItemStarted(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: OutputState,
  send: (c: ReadableStreamDefaultController<Uint8Array>, e: Record<string, unknown>) => void,
): void {
  if (state.messageStarted) return

  state.messageItemId = `msg_${randomUUID().replace(/-/g, '')}`
  state.messageOutputIndex = state.nextOutputIndex++
  state.messageStarted = true

  send(controller, {
    type: 'response.output_item.added',
    output_index: state.messageOutputIndex,
    item: {
      type: 'message',
      id: state.messageItemId,
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
  })

  send(controller, {
    type: 'response.content_part.added',
    item_id: state.messageItemId,
    output_index: state.messageOutputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  })
  state.messageContentPartStarted = true
}

/** 关闭可能还在 in_progress 的 message item */
function finalizeMessageItem(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: OutputState,
  send: (c: ReadableStreamDefaultController<Uint8Array>, e: Record<string, unknown>) => void,
): void {
  if (!state.messageStarted || !state.messageItemId || state.messageOutputIndex === null) return
  // 如果还没关闭（用一个 flag 区分多次调用）
  if ((state as unknown as { messageFinalized?: boolean }).messageFinalized) return
  ;(state as unknown as { messageFinalized?: boolean }).messageFinalized = true

  if (state.messageContentPartStarted) {
    send(controller, {
      type: 'response.output_text.done',
      item_id: state.messageItemId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      text: state.messageText,
      logprobs: [],
    })
    send(controller, {
      type: 'response.content_part.done',
      item_id: state.messageItemId,
      output_index: state.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: state.messageText, annotations: [] },
    })
  }

  send(controller, {
    type: 'response.output_item.done',
    output_index: state.messageOutputIndex,
    item: {
      type: 'message',
      id: state.messageItemId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: state.messageText, annotations: [] }],
    },
  })
}

/** 收尾所有打开的 tool call items */
function finalizeToolCallItems(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: OutputState,
  send: (c: ReadableStreamDefaultController<Uint8Array>, e: Record<string, unknown>) => void,
): void {
  for (const tc of state.toolCalls.values()) {
    if (!tc.itemStarted) continue

    send(controller, {
      type: 'response.function_call_arguments.done',
      item_id: tc.itemId,
      output_index: tc.outputIndex,
      name: tc.name,
      arguments: tc.argsBuffer,
    })

    send(controller, {
      type: 'response.output_item.done',
      output_index: tc.outputIndex,
      item: {
        type: 'function_call',
        id: tc.itemId,
        status: 'completed',
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.argsBuffer,
      },
    })
  }
}
