import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { getAuthPath } from '../auth/token-store.js'

/**
 * logout 命令：删 auth.json，等价于退出 Copilot 授权
 * 下次需要用 login 重新走 device flow
 */
export async function logoutCommand(): Promise<void> {
  const path = getAuthPath()
  if (!existsSync(path)) {
    console.log(`未发现 auth 文件（${path}），无需退出`)
    return
  }
  await unlink(path)
  console.log(`已退出 Copilot 授权（已删除 ${path}）`)
  console.log('提示：GitHub 端的 OAuth token 仍有效；如需彻底撤销请去 github.com/settings/applications')
}
