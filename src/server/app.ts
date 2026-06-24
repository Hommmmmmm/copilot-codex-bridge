import { Hono } from 'hono'
import { responsesRoute } from './responses-route.js'
import { modelsRoute } from './models-route.js'
import { modelCatalogRoute } from './catalog-route.js'

/**
 * 构建 hono app，挂上 /v1/responses 和 /v1/models
 * 全局错误中间件：所有未捕获异常 → JSON 错误响应（不让请求挂死）
 */
export function buildApp(): Hono {
  const app = new Hono()

  // 简单的请求日志
  app.use('*', async (c, next) => {
    const t0 = Date.now()
    await next()
    const elapsed = Date.now() - t0
    console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} ${c.res.status} ${elapsed}ms`)
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

  // 健康检查
  app.get('/', (c) => c.json({ ok: true, service: 'copilot-codex-bridge' }))

  // OpenAI 兼容端点
  app.post('/v1/responses', responsesRoute)
  app.get('/v1/models', modelsRoute)

  // 给 Codex.app renderer 注入的 JS 用的 catalog
  app.get('/v1/model-catalog', modelCatalogRoute)

  // 全局错误处理
  app.onError((err, c) => {
    console.error('[server] 请求出错：', err)
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
