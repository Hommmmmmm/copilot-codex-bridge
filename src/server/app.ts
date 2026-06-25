import { hostname } from 'node:os'
import type { IncomingMessage } from 'node:http'
import { Hono } from 'hono'
import { responsesRoute } from './responses-route.js'
import { modelsRoute } from './models-route.js'
import { modelCatalogRoute } from './catalog-route.js'

/** 从 @hono/node-server env 提取真实客户端 IP（去掉 IPv6 ::ffff: 前缀 + ::1 → 127.0.0.1） */
function remoteIp(c: import('hono').Context): string {
  const env = c.env as { incoming?: IncomingMessage } | undefined
  const raw = env?.incoming?.socket?.remoteAddress ?? ''
  if (!raw) return '?'
  if (raw === '::1') return '127.0.0.1'
  return raw.replace(/^::ffff:/, '')
}

/** 简短 user-agent 标识，方便在日志里区分 curl / Codex / 浏览器 */
function shortUA(ua: string | undefined): string {
  if (!ua) return ''
  if (ua.includes('curl/')) return ua.match(/curl\/[\d.]+/)?.[0] ?? 'curl'
  if (ua.includes('Codex')) return 'Codex.app'
  if (ua.includes('node-fetch')) return 'node-fetch'
  if (ua.includes('Mozilla')) {
    if (ua.includes('Chrome')) return 'Chrome'
    if (ua.includes('Safari')) return 'Safari'
    if (ua.includes('Firefox')) return 'Firefox'
    return 'Browser'
  }
  // 截断超长 UA
  return ua.length > 60 ? ua.slice(0, 60) + '…' : ua
}

/**
 * 构建 hono app，挂上 /v1/responses 和 /v1/models
 * 全局错误中间件：所有未捕获异常 → JSON 错误响应（不让请求挂死）
 */
export function buildApp(): Hono {
  const app = new Hono()

  // 请求日志：带客户端 IP + UA，方便排查「同局域网谁在调」
  // 局域网调用（非 127.0.0.1）显式加 [LAN] 前缀让运维一眼看到
  app.use('*', async (c, next) => {
    const t0 = Date.now()
    const ip = remoteIp(c)
    const ua = shortUA(c.req.header('user-agent'))
    const lanTag = ip === '127.0.0.1' || ip === '?' ? '' : '[LAN] '
    await next()
    const elapsed = Date.now() - t0
    const tail = ua ? ` ua=${ua}` : ''
    console.log(
      `${lanTag}[${new Date().toISOString()}] ${ip} → ${c.req.method} ${c.req.path} ${c.res.status} ${elapsed}ms${tail}`,
    )
  })

  // CORS：让 Codex.app renderer（origin app://-）的 JS 能跨域调本地 API
  // 否则 fetch('http://127.0.0.1:8787/v1/model-catalog') 会被浏览器 CORS 拦截
  app.use('*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Allow-Headers', '*')
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204)
    }
    await next()
  })

  // 健康检查 / 连通性测试
  // 任何人在浏览器或 curl 打开 http://<host>:<port>/health 都能看到详细 JSON，
  // 用于排查「同局域网到底通不通」、「连到的是不是预期的那台机器」
  const healthHandler = (c: import('hono').Context) => {
    const ip = remoteIp(c)
    if (ip !== '127.0.0.1' && ip !== '?') {
      console.log(`✓ [health] 局域网客户端 ${ip} 连通成功`)
    }
    return c.json({
      ok: true,
      service: 'copilot-codex-bridge',
      hostname: hostname(),
      yourIp: ip,
      time: new Date().toISOString(),
    })
  }
  app.get('/', healthHandler)
  app.get('/health', healthHandler)
  app.get('/ping', (c) => {
    const ip = remoteIp(c)
    if (ip !== '127.0.0.1' && ip !== '?') {
      console.log(`✓ [ping] 局域网客户端 ${ip}`)
    }
    return c.text('pong\n')
  })

  // OpenAI 兼容端点：拉模型 / 跑 responses
  // /v1/models 是 Codex CLI、其他 OpenAI 兼容客户端「获取模型列表」的标准入口，
  // 同事调试时几乎一定先打这条 — 高亮一下
  app.get('/v1/models', (c) => {
    const ip = remoteIp(c)
    if (ip !== '127.0.0.1' && ip !== '?') {
      console.log(`📋 [v1/models] ← 局域网客户端 ${ip} 请求模型列表`)
    }
    return modelsRoute(c)
  })

  app.post('/v1/responses', (c) => {
    const ip = remoteIp(c)
    if (ip !== '127.0.0.1' && ip !== '?') {
      console.log(`💬 [v1/responses] ← 局域网客户端 ${ip} 提交对话请求`)
    }
    return responsesRoute(c)
  })

  // 给 Codex.app renderer 注入的 JS 用的 catalog
  app.get('/v1/model-catalog', modelCatalogRoute)

  // 全局错误处理
  app.onError((err, c) => {
    const ip = remoteIp(c)
    console.error(`[server] ${ip} → ${c.req.method} ${c.req.path} 出错：`, err)
    return c.json(
      {
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'bridge_error',
        },
      },
      500,
    )
  })

  return app
}
