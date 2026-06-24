import { serve } from '@hono/node-server'
import { buildApp } from '../server/app.js'
import { ensureValidCopilotToken, startTokenRefresher } from '../auth/copilot-token.js'

/**
 * start 命令：启动 hono HTTP server，暴露 /v1/responses 和 /v1/models
 * 同时拉起 Copilot token 自动续期任务
 */
export interface StartOptions {
  port: number
}

export async function startCommand(opts: StartOptions): Promise<void> {
  // 启动前先确认 token 可用，提前暴露未登录错误
  await ensureValidCopilotToken()
  console.log('Copilot token 有效')

  // 后台续期
  const cancelRefresh = startTokenRefresher()

  const app = buildApp()
  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    hostname: '127.0.0.1',
  })

  console.log(`代理服务已启动：http://127.0.0.1:${opts.port}`)
  console.log(`  POST /v1/responses  — 给 Codex CLI 用`)
  console.log(`  GET  /v1/models     — 列出 Copilot 可用模型`)
  console.log(`按 Ctrl+C 退出`)

  // 优雅退出
  const shutdown = () => {
    console.log('\n正在关闭...')
    cancelRefresh()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
