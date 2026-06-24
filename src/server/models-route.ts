import type { Context } from 'hono'
import { listCopilotModels } from '../copilot/models.js'

/**
 * GET /v1/models
 * 把 Copilot 可用模型列表以 OpenAI 兼容格式返回
 * Codex CLI 可能会调这个 endpoint 列出可选模型
 */
export async function modelsRoute(c: Context): Promise<Response> {
  const models = await listCopilotModels()

  // OpenAI /v1/models 标准格式
  const data = models.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.vendor ?? 'copilot',
  }))

  return c.json({
    object: 'list',
    data,
  })
}
