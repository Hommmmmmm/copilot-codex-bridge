import { loadAuth, saveAuth, type AuthStore } from './token-store.js'

/**
 * GitHub Copilot internal token 接口返回结构
 * 关键字段：token（实际调用 Copilot 用的 Bearer）、expires_at（Unix 秒）、refresh_in（推荐刷新间隔）
 * endpoints 里通常会包含 api、telemetry 等子路径的 base url
 */
interface CopilotTokenResponse {
  token: string
  expires_at: number
  refresh_in: number
  endpoints?: Record<string, string>
  // 其他字段忽略
}

/**
 * 用 GitHub OAuth token 调 copilot_internal endpoint，换取短期 Copilot token
 * 必须带模拟 VS Code 的 User-Agent 和 Editor 头才能通过
 */
export async function fetchCopilotToken(githubToken: string): Promise<CopilotTokenResponse> {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    method: 'GET',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Editor-Version': 'vscode/1.99.3',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`换取 Copilot token 失败：HTTP ${res.status} ${body}`)
  }

  return (await res.json()) as CopilotTokenResponse
}

/**
 * 确保拿到一个有效的 Copilot token：
 * - 如果已存且未过期（保留 60s 安全边际），直接用
 * - 否则用持久化的 github_token 重新换一个，写回磁盘
 *
 * 调用者：每次发请求前调用一次，幂等
 */
export async function ensureValidCopilotToken(): Promise<AuthStore> {
  const auth = await loadAuth()
  if (!auth) {
    throw new Error('未登录，请先执行 `copilot-bridge login`')
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const safetyMargin = 60

  // token 仍然有效则直接返回
  if (auth.copilot_token && auth.copilot_expires_at > nowSec + safetyMargin) {
    return auth
  }

  // 否则刷新
  const fresh = await fetchCopilotToken(auth.github_token)
  const updated: AuthStore = {
    ...auth,
    copilot_token: fresh.token,
    copilot_expires_at: fresh.expires_at,
    copilot_refresh_in: fresh.refresh_in,
    endpoints: fresh.endpoints,
  }
  await saveAuth(updated)
  return updated
}

/**
 * 启动后台续期任务：根据 refresh_in 间隔自动刷 token
 * 返回一个 cancel 函数，调用后停止续期
 *
 * 设计：每次刷新成功后用新的 refresh_in 重新调度，链式 setTimeout 避免 drift
 */
export function startTokenRefresher(): () => void {
  let cancelled = false
  let timer: NodeJS.Timeout | null = null

  const scheduleNext = (delayMs: number) => {
    if (cancelled) return
    timer = setTimeout(async () => {
      if (cancelled) return
      try {
        const auth = await ensureValidCopilotToken()
        // 用 refresh_in 而不是 expires_at - now，遵从 Copilot 推荐节奏
        const next = (auth.copilot_refresh_in ?? 1500) * 1000
        scheduleNext(next)
      } catch (err) {
        console.error('[token-refresher] 续期失败，1 分钟后重试：', err)
        scheduleNext(60_000)
      }
    }, delayMs)
  }

  // 启动时立刻调度第一次，间隔从已有 store 读取
  loadAuth()
    .then((auth) => {
      const refreshIn = auth?.copilot_refresh_in ?? 1500
      scheduleNext(refreshIn * 1000)
    })
    .catch(() => scheduleNext(60_000))

  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
