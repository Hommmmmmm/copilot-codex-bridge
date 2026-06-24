import { loadAuth, getAuthPath } from '../auth/token-store.js'
import { inspectInstallation } from '../codex/config.js'

/**
 * status 命令：检查三件套状态
 * 1) auth.json 是否存在 + Copilot token 是否在有效期内
 * 2) 本地 8787 端口是否有 server 在跑（用 fetch 健康检查）
 * 3) ~/.codex/config.toml 是否已注入 copilot_proxy provider + 当前在用什么模型
 */
export async function statusCommand(): Promise<void> {
  console.log('=== 认证 ===')
  const auth = await loadAuth()
  if (!auth) {
    console.log(`  [未登录] 请运行 copilot-bridge login`)
    console.log(`  auth 文件路径：${getAuthPath()}`)
  } else {
    const nowSec = Math.floor(Date.now() / 1000)
    const remain = auth.copilot_expires_at - nowSec
    const expiresAt = new Date(auth.copilot_expires_at * 1000).toLocaleString()
    if (remain > 0) {
      console.log(`  [有效] Copilot token 剩余 ${Math.floor(remain / 60)} 分钟`)
      console.log(`  过期时间：${expiresAt}`)
    } else {
      console.log(`  [已过期] 启动 start 命令时会自动续期`)
    }
    console.log(`  auth 文件：${getAuthPath()}`)
  }

  console.log('')
  console.log('=== 代理 Server ===')
  try {
    const res = await fetch('http://127.0.0.1:8787/', { signal: AbortSignal.timeout(1000) })
    if (res.ok) {
      console.log(`  [运行中] http://127.0.0.1:8787`)
    } else {
      console.log(`  [响应异常] HTTP ${res.status}`)
    }
  } catch {
    console.log(`  [未运行] 请运行 copilot-bridge start`)
  }

  console.log('')
  console.log('=== Codex 配置 ===')
  const inst = await inspectInstallation()
  console.log(`  config.toml: ${inst.configExists ? '存在' : '不存在'} (${inst.configPath})`)
  console.log(`  copilot_proxy provider: ${inst.providerInstalled ? '已注入' : '未注入'}`)
  console.log(`  profile 文件: ${inst.profileExists ? '存在' : '不存在'} (${inst.profilePath})`)
  console.log(`  当前 model_provider: ${inst.currentProvider ?? '(未设置)'}`)
  console.log(`  当前 model: ${inst.currentModel ?? '(未设置)'}`)
  console.log(`  Codex 当前是否走 copilot 代理: ${inst.isUsingCopilot ? '是' : '否'}`)
  if (!inst.providerInstalled) {
    console.log(`  → 运行 copilot-bridge install 完成配置注入`)
  } else if (!inst.isUsingCopilot) {
    console.log(`  → 运行 copilot-bridge switch <model> 切到 copilot 代理`)
  }
}
