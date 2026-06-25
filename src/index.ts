import { Command } from 'commander'
import { loginCommand } from './commands/login.js'
import { logoutCommand } from './commands/logout.js'
import { startCommand } from './commands/start.js'
import { installCommand } from './commands/install.js'
import { uninstallCommand } from './commands/uninstall.js'
import { statusCommand } from './commands/status.js'
import { switchCommand } from './commands/switch.js'
import { launchCommand } from './commands/launch.js'

// CLI 入口
const program = new Command()

program
  .name('copilot-bridge')
  .description('本地代理：把 GitHub Copilot 包装成 OpenAI Responses API 给 Codex 使用')
  .version('0.1.0')

// 一次性授权：触发 GitHub device flow，持久化 token
program
  .command('login')
  .description('GitHub 授权登录（device flow），拿到 Copilot token 并持久化')
  .action(loginCommand)

// 退出授权：删 auth.json
program
  .command('logout')
  .description('退出 Copilot 授权（删除本地 auth 文件）')
  .action(logoutCommand)

// 启动代理 server
program
  .command('start')
  .description('启动本地 HTTP 代理（前台）')
  .option('-p, --port <number>', '监听端口', '8787')
  .option('--host <ip>', '监听地址。127.0.0.1 = 仅本机；0.0.0.0 = 同局域网可访问', '127.0.0.1')
  .action((opts) => startCommand({ port: Number(opts.port), host: String(opts.host) }))

// 把代理写入 Codex config
program
  .command('install')
  .description('修改 ~/.codex/config.toml，注入 copilot_proxy provider + copilot profile（先备份）')
  .action(installCommand)

// 从 Codex config 移除我们的段
program
  .command('uninstall')
  .description('从 ~/.codex/config.toml 移除 copilot_proxy provider 和 copilot profile')
  .action(uninstallCommand)

// 三件套状态检查
program
  .command('status')
  .description('检查 token / server / config 三件套状态')
  .action(statusCommand)

// 一键切换 Codex 默认模型（仿 CodexPlusPlus 的切换体验）
program
  .command('switch [model]')
  .description('切换 Codex 默认使用的 Copilot 模型；不带参数则列出可选模型')
  .action(switchCommand)

// 一键切换模型 + 自动重启 Codex.app
program
  .command('launch [model]')
  .description('切换模型并自动重启 Codex.app（switch 的二合一版）')
  .action(launchCommand)

program.parseAsync(process.argv).catch((err) => {
  console.error('[copilot-bridge] 执行失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
