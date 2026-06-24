import { switchModel } from '../codex/config.js'
import { listCopilotModels, filterUsableChatModels } from '../copilot/models.js'

/**
 * switch 命令：一键切换 Codex 桌面端使用的 Copilot 模型
 *
 * 原理：直接改 ~/.codex/config.toml 的顶层 model + model_provider
 * 桌面端 Codex 重启后会读取新模型（菜单不显示也没关系，model 字段直接生效）
 *
 * 用法：copilot-bridge switch claude-opus-4.7
 *      copilot-bridge switch                    （列出可用模型让用户挑）
 */
export async function switchCommand(modelArg: string | undefined): Promise<void> {
  // 拉模型列表，用于校验 + 列举
  const all = await listCopilotModels()
  const usable = filterUsableChatModels(all)
  const usableIds = new Set(usable.map((m) => m.id))

  // 没传 model：列出可选
  if (!modelArg) {
    console.log('可用模型（按 Copilot 推荐）：')
    for (const m of usable) {
      const tag = m.model_picker_category ? ` [${m.model_picker_category}]` : ''
      console.log(`  ${m.id.padEnd(28)} ${m.name ?? ''}${tag}`)
    }
    console.log('\n用法：copilot-bridge switch <model-id>')
    return
  }

  if (!usableIds.has(modelArg)) {
    console.error(`模型 "${modelArg}" 不在可用列表里`)
    console.error('运行 `copilot-bridge switch` 不带参数可列出全部可用模型')
    process.exitCode = 1
    return
  }

  const { previousModel, previousProvider } = await switchModel(modelArg)

  console.log(`已切换默认模型：${previousModel ?? '(无)'} → ${modelArg}`)
  if (previousProvider !== 'copilot_proxy') {
    console.log(`provider 也已切换：${previousProvider ?? '(无)'} → copilot_proxy`)
  }
  console.log('\n请完全退出 Codex.app（⌘Q）后重新打开，新模型即可生效')
}
