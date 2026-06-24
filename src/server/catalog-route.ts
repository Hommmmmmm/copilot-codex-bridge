import type { Context } from 'hono'
import { listCopilotModels, filterUsableChatModels } from '../copilot/models.js'

/**
 * GET /v1/model-catalog
 *
 * 返回简化版 model catalog 给 Codex.app renderer 注入的 JS 调用
 * 注入脚本会拿这个列表 patch Codex 模型菜单（让 Claude/Gemini 显示出来）
 *
 * 响应格式跟 CodexPlusPlus 的 /codex-model-catalog 字段对齐：
 *   { status, model, default_model, model_provider, provider_name, models[], sources[], responses_api }
 *
 * 我们只填关键字段（status/models/default_model/provider_name），其他保留空值兼容
 */
export async function modelCatalogRoute(c: Context): Promise<Response> {
  try {
    const all = await listCopilotModels()
    const usable = filterUsableChatModels(all)

    // 按 CodexPlusPlus 的优先级排序：powerful → versatile → lightweight
    const categoryOrder: Record<string, number> = {
      powerful: 0,
      versatile: 1,
      lightweight: 2,
    }
    const sorted = [...usable].sort((a, b) => {
      const ca = categoryOrder[a.model_picker_category ?? ''] ?? 99
      const cb = categoryOrder[b.model_picker_category ?? ''] ?? 99
      if (ca !== cb) return ca - cb
      return a.id.localeCompare(b.id)
    })

    const modelIds = sorted.map((m) => m.id)
    const defaultModel =
      modelIds.find((id) => id === 'claude-opus-4.7') ??
      modelIds.find((id) => id === 'gpt-5.4') ??
      modelIds[0] ??
      ''

    return c.json({
      status: 'ok',
      model: defaultModel,
      default_model: defaultModel,
      model_provider: 'copilot_proxy',
      provider_name: 'Copilot via local proxy',
      models: modelIds,
      sources: [
        {
          id: 'copilot',
          type: 'copilot',
          name: 'GitHub Copilot',
          base_url: 'https://api.githubcopilot.com',
          status: 'ok',
          models: modelIds.length,
        },
      ],
      responses_api: {
        status: 'ok',
        endpoint: 'http://127.0.0.1:8787/v1/responses',
        message: '',
      },
    })
  } catch (err) {
    return c.json({
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
      model: '',
      default_model: '',
      model_provider: 'copilot_proxy',
      provider_name: 'Copilot via local proxy',
      models: [],
      sources: [],
      responses_api: { status: 'unknown', endpoint: '', message: '' },
    })
  }
}
