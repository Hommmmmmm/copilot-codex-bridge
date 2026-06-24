import { uninstall } from '../codex/config.js'

/**
 * uninstall 命令：从 ~/.codex/config.toml 中移除我们注入的段
 * 同时清理 ~/.codex/copilot.config.toml profile 文件
 */
export async function uninstallCommand(): Promise<void> {
  const { removed } = await uninstall()
  if (removed) {
    console.log('已清理 Codex 中的 copilot_proxy 配置')
  } else {
    console.log('没有发现 copilot_proxy 配置（可能未安装或已被手动清理）')
  }
}
