import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/**
 * 持久化到磁盘的认证状态
 * github_token 长期有效（除非用户撤销），copilot_token 短期（~30 min）
 */
export interface AuthStore {
  /** GitHub OAuth access token（用来换 copilot token） */
  github_token: string
  /** Copilot 短期 token（带 Bearer 调用 api.githubcopilot.com） */
  copilot_token: string
  /** Copilot token 过期时间（Unix 秒） */
  copilot_expires_at: number
  /** Copilot 给的推荐刷新间隔（秒），可能小于 expires_at - now */
  copilot_refresh_in?: number
  /** Copilot 返回的 endpoints 段，告诉我们应该往哪个 base url 发请求 */
  endpoints?: Record<string, string>
}

const AUTH_DIR = join(homedir(), '.copilot-codex-bridge')
const AUTH_FILE = join(AUTH_DIR, 'auth.json')

/** 读取持久化的认证信息，没有则返回 null */
export async function loadAuth(): Promise<AuthStore | null> {
  if (!existsSync(AUTH_FILE)) return null
  try {
    const raw = await readFile(AUTH_FILE, 'utf8')
    return JSON.parse(raw) as AuthStore
  } catch {
    // 文件损坏视为无效，让上层重新走 login
    return null
  }
}

/** 写入认证信息，目录不存在自动创建 */
export async function saveAuth(auth: AuthStore): Promise<void> {
  if (!existsSync(AUTH_DIR)) {
    await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 })
  }
  // mode 0o600：仅当前用户读写，避免泄露 token
  await writeFile(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 })
}

/** auth.json 的绝对路径，供 status 命令显示用 */
export function getAuthPath(): string {
  return AUTH_FILE
}
