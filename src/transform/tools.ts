/**
 * Tool calling 在 Chat Completions 和 Responses 之间的字段映射
 *
 * 关键差异：
 * - Chat: tools[].{type:"function", function:{name,description,parameters}}
 *   Responses: tools[].{type:"function", name, description, parameters}  ← function 字段被拍平
 *
 * - Chat 调用：message.tool_calls[].{id, type:"function", function:{name, arguments}}
 *   Responses 调用：output[]{type:"function_call", id, call_id, name, arguments}
 *   注意 Responses 的 id（item id）和 call_id 是两个字段，回传时用 call_id
 *
 * - Chat 结果：{role:"tool", tool_call_id, content}
 *   Responses 结果：input[]{type:"function_call_output", call_id, output}
 *
 * Codex 还会发 namespace 类型（包含 nested tools 数组），这种要展平
 */

/** Responses API 的 tool 定义（拍平结构 / 或 namespace） */
export type ResponsesToolDef =
  | {
      type: 'function'
      name: string
      description?: string
      parameters: Record<string, unknown>
      strict?: boolean
    }
  | {
      // Codex 私有：namespace 类型，把多个 function 打包成一个 tool entry
      type: 'namespace'
      name: string
      description?: string
      tools: Array<{
        type: 'function'
        name: string
        description?: string
        parameters: Record<string, unknown>
        strict?: boolean
      }>
    }
  | {
      // 其他不认识的类型（如 web_search、computer_use 等），直接丢弃
      type: string
      [key: string]: unknown
    }

/** Chat Completions 的 tool 定义（嵌套 function 字段） */
export interface ChatToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

/**
 * Responses tools → Chat Completions tools（拍平转嵌套）
 * - function 类型：直接转
 * - namespace 类型：展平里面所有 nested function，用 `<ns>.<name>` 作为新 name
 * - 其他类型：跳过（Copilot 不支持）
 * - name 为空的 function：跳过（Copilot 会 400）
 */
export function toolsResponsesToChat(
  tools: ResponsesToolDef[] | undefined,
): ChatToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined

  const result: ChatToolDef[] = []
  for (const t of tools) {
    if (t.type === 'function') {
      const ft = t as Extract<ResponsesToolDef, { type: 'function' }>
      if (!ft.name || ft.name.length === 0) continue
      result.push({
        type: 'function',
        function: {
          name: ft.name,
          description: ft.description,
          parameters: ft.parameters,
          strict: ft.strict,
        },
      })
    } else if (t.type === 'namespace') {
      const nt = t as Extract<ResponsesToolDef, { type: 'namespace' }>
      const nsName = nt.name
      for (const sub of nt.tools ?? []) {
        if (!sub.name || sub.name.length === 0) continue
        // 用 `ns__name` 形式避免 OpenAI 工具名规则限制（不能含点号）
        result.push({
          type: 'function',
          function: {
            name: `${nsName}__${sub.name}`,
            description: sub.description,
            parameters: sub.parameters,
            strict: sub.strict,
          },
        })
      }
    }
    // 其他 type（web_search 等）静默丢弃
  }

  return result.length > 0 ? result : undefined
}
