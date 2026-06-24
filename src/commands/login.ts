import { runDeviceFlow } from '../auth/device-flow.js'
import { fetchCopilotToken } from '../auth/copilot-token.js'
import { saveAuth, getAuthPath } from '../auth/token-store.js'

/**
 * login 命令：触发 GitHub OAuth device flow，拿到 access_token 后
 * 再调 Copilot internal token endpoint 拿短期 token，全部持久化到磁盘
 */
export async function loginCommand(): Promise<void> {
  // 步骤 1：GitHub OAuth device flow
  const githubToken = await runDeviceFlow()

  // 步骤 2：用 GitHub token 换 Copilot 短期 token
  console.log('正在换取 Copilot token...')
  const copilot = await fetchCopilotToken(githubToken)

  // 步骤 3：持久化
  await saveAuth({
    github_token: githubToken,
    copilot_token: copilot.token,
    copilot_expires_at: copilot.expires_at,
    copilot_refresh_in: copilot.refresh_in,
    endpoints: copilot.endpoints,
  })

  const expiresAt = new Date(copilot.expires_at * 1000).toLocaleString()
  console.log(`登录成功`)
  console.log(`  auth 文件：${getAuthPath()}`)
  console.log(`  Copilot token 过期时间：${expiresAt}`)
  console.log(`  推荐续期间隔：${copilot.refresh_in}s`)
}
