import { install } from '../codex/config.js'
import { listCopilotModels, filterUsableChatModels } from '../copilot/models.js'

/**
 * install 命令：注入 copilot_proxy provider 到 ~/.codex/config.toml
 * - 写 [model_providers.copilot_proxy] 段（requires_openai_auth=true，不需要 API key）
 * - 写 profile 文件 ~/.codex/copilot.config.toml
 * - 改动前先备份原 config.toml
 *
 * 不修改顶层 model / model_provider —— 用户用 switch 命令显式切换
 */
export async function installCommand(): Promise<void> {
  console.log('正在获取 Copilot 可用模型列表...')
  let defaultModel = 'claude-opus-4.7'
  try {
    const all = await listCopilotModels()
    const usable = filterUsableChatModels(all)
    // 默认挑当前最强模型（优先级：claude-opus-4.7 > gpt-5.4 > 列表第一个）
    const preferred =
      usable.find((m) => m.id === 'claude-opus-4.7') ??
      usable.find((m) => m.id === 'gpt-5.4') ??
      usable[0]
    if (preferred) defaultModel = preferred.id
  } catch (err) {
    console.warn(`  获取模型列表失败，使用默认 ${defaultModel}：`, err instanceof Error ? err.message : err)
  }

  const { backupPath } = await install({ port: 8787, model: defaultModel })

  console.log('Codex 配置已写入')
  console.log(`  profile 默认模型：${defaultModel}`)
  if (backupPath) {
    console.log(`  原 config.toml 已备份到：${backupPath}`)
  }
  console.log('')
  console.log('下一步：')
  console.log('  1. 启动代理：copilot-bridge start')
  console.log('  2. 切到 copilot 模型：copilot-bridge switch claude-opus-4.7')
  console.log('  3. 完全退出 Codex.app 后重新打开')
}
