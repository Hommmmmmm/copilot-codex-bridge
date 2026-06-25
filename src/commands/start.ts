import { networkInterfaces } from 'node:os'
import { serve } from '@hono/node-server'
import { buildApp } from '../server/app.js'
import { ensureValidCopilotToken, startTokenRefresher } from '../auth/copilot-token.js'

/**
 * start 命令：启动 hono HTTP server，暴露 /v1/responses 和 /v1/models
 * 同时拉起 Copilot token 自动续期任务
 *
 * host:
 *   - "127.0.0.1"（默认）— 只 loopback，本机访问
 *   - "0.0.0.0"           — 所有网卡，同局域网可访问 http://<本机 LAN IP>:<port>
 */
export interface StartOptions {
  port: number
  host?: string
}

export async function startCommand(opts: StartOptions): Promise<void> {
  // 启动前先确认 token 可用，提前暴露未登录错误
  await ensureValidCopilotToken()
  console.log('Copilot token 有效')

  // 后台续期
  const cancelRefresh = startTokenRefresher()

  const hostname = opts.host && opts.host.trim() ? opts.host.trim() : '127.0.0.1'

  const app = buildApp()
  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    hostname,
  })

  console.log(`代理服务已启动：http://${hostname}:${opts.port}`)
  if (hostname === '0.0.0.0') {
    const lanIps = listLanIPv4()
    if (lanIps.length > 0) {
      console.log('  局域网访问地址：')
      for (const ip of lanIps) {
        console.log(`    http://${ip}:${opts.port}/v1`)
      }
    }
  }
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

/** 列出所有非 loopback 的 IPv4 地址，用于打印「局域网访问地址」 */
function listLanIPv4(): string[] {
  const nets = networkInterfaces()
  const ips: string[] = []
  for (const list of Object.values(nets)) {
    if (!list) continue
    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}

