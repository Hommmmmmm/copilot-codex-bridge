import { homedir } from 'node:os'
import { join } from 'node:path'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import TOML from '@iarna/toml'

const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const CODEX_CONFIG = join(CODEX_DIR, 'config.toml')
const COPILOT_PROFILE = join(CODEX_DIR, 'copilot.config.toml')

/** 注入的 provider 段名（用作 model_providers.<name>，install/uninstall 都靠它定位） */
export const PROVIDER_ID = 'copilot_proxy'

export interface InstallOptions {
  /** 代理 server 监听端口 */
  port: number
  /** 默认使用的 Copilot 模型 ID */
  model: string
}

/**
 * install：把 [model_providers.copilot_proxy] 段并入 ~/.codex/config.toml
 * 同时写入独立 profile 文件 ~/.codex/copilot.config.toml
 * 改动前备份原 config.toml
 *
 * 完全独立，不依赖 OpenAI 授权：
 *   requires_openai_auth = false        → Codex 不强求 OpenAI 登录态
 *   experimental_bearer_token = "dummy" → 占位 bearer，代理收到后忽略
 */
export async function install(opts: InstallOptions): Promise<{ backupPath: string | null }> {
  if (!existsSync(CODEX_DIR)) {
    await mkdir(CODEX_DIR, { recursive: true })
  }

  let config: Record<string, unknown> = {}
  let backupPath: string | null = null

  if (existsSync(CODEX_CONFIG)) {
    const raw = await readFile(CODEX_CONFIG, 'utf8')
    config = TOML.parse(raw) as Record<string, unknown>

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = `${CODEX_CONFIG}.bak.${ts}`
    await copyFile(CODEX_CONFIG, backupPath)
  }

  // 合并 model_providers.copilot_proxy — 完全独立，不依赖 OpenAI 授权
  const providers = (config.model_providers as Record<string, unknown>) ?? {}
  providers[PROVIDER_ID] = {
    name: 'Copilot via local proxy',
    base_url: `http://127.0.0.1:${opts.port}/v1`,
    wire_api: 'responses',
    requires_openai_auth: false,
    experimental_bearer_token: 'dummy',
  }
  config.model_providers = providers

  await writeFile(CODEX_CONFIG, TOML.stringify(config as TOML.JsonMap), 'utf8')

  // 写 profile 文件（v0.134.0+ 新机制：~/.codex/<profile>.config.toml）
  const profileContent: Record<string, unknown> = {
    model: opts.model,
    model_provider: PROVIDER_ID,
  }
  await writeFile(COPILOT_PROFILE, TOML.stringify(profileContent as TOML.JsonMap), 'utf8')

  return { backupPath }
}

/**
 * switch：直接改 ~/.codex/config.toml 的顶层 model + model_provider，
 * 让桌面端 Codex 重启后用指定模型
 *
 * 这是模仿 CodexPlusPlus / cc-switch 的核心机制：菜单管不到，那就直接改 config。
 */
export async function switchModel(model: string): Promise<{
  previousModel: string | null
  previousProvider: string | null
}> {
  if (!existsSync(CODEX_CONFIG)) {
    throw new Error(`找不到 ~/.codex/config.toml，请先运行 copilot-bridge install`)
  }

  const raw = await readFile(CODEX_CONFIG, 'utf8')
  const config = TOML.parse(raw) as Record<string, unknown>

  const previousModel = (config.model as string) ?? null
  const previousProvider = (config.model_provider as string) ?? null

  // 确认 copilot_proxy provider 段已存在（否则 Codex 启动会报错）
  const providers = config.model_providers as Record<string, unknown> | undefined
  if (!providers?.[PROVIDER_ID]) {
    throw new Error(`config.toml 里没有 [model_providers.${PROVIDER_ID}] 段，请先运行 copilot-bridge install`)
  }

  config.model = model
  config.model_provider = PROVIDER_ID

  await writeFile(CODEX_CONFIG, TOML.stringify(config as TOML.JsonMap), 'utf8')

  return { previousModel, previousProvider }
}

/**
 * ensureProviderConfig：**强制**覆盖 ~/.codex/config.toml 关键字段
 *
 * 防止 cc-switch / 其他 Codex 管理工具篡改：
 *   - [model_providers.copilot_proxy] 段：强制覆盖 base_url / wire_api / requires_openai_auth
 *   - 顶层 model_provider: 强制设为 copilot_proxy
 *   - 顶层 model: 强制设为传入的 model
 *
 * launch 命令应该在每次启动 Codex 前调用，保证 config 是「我们想要的」
 * 其他字段（marketplaces / plugins / mcp_servers 等用户自定义）原封不动
 */
export async function ensureProviderConfig(port: number, model: string): Promise<{
  changed: boolean
  fixedBaseUrl: boolean
  fixedTopLevel: boolean
}> {
  if (!existsSync(CODEX_CONFIG)) {
    throw new Error(`找不到 ~/.codex/config.toml，请先运行 copilot-bridge install`)
  }

  const raw = await readFile(CODEX_CONFIG, 'utf8')
  const config = TOML.parse(raw) as Record<string, unknown>

  const expectedBaseUrl = `http://127.0.0.1:${port}/v1`
  const expectedProvider = {
    name: 'Copilot via local proxy',
    base_url: expectedBaseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    experimental_bearer_token: 'dummy',
  }

  // 1. 强制覆盖 provider 段
  const providers = (config.model_providers as Record<string, unknown>) ?? {}
  const existing = providers[PROVIDER_ID] as Record<string, unknown> | undefined
  const fixedBaseUrl =
    !existing ||
    existing.base_url !== expectedBaseUrl ||
    existing.wire_api !== 'responses' ||
    existing.requires_openai_auth !== false
  providers[PROVIDER_ID] = expectedProvider
  config.model_providers = providers

  // 2. 强制顶层 model_provider + model
  const fixedTopLevel = config.model_provider !== PROVIDER_ID || config.model !== model
  config.model_provider = PROVIDER_ID
  config.model = model

  const changed = fixedBaseUrl || fixedTopLevel
  if (changed) {
    await writeFile(CODEX_CONFIG, TOML.stringify(config as TOML.JsonMap), 'utf8')
  }

  return { changed, fixedBaseUrl, fixedTopLevel }
}

/**
 * uninstall：从 ~/.codex/config.toml 移除我们的 provider 段
 * 同时删除 ~/.codex/copilot.config.toml profile 文件
 * 不动其他配置
 */
export async function uninstall(): Promise<{ removed: boolean }> {
  let removed = false

  if (existsSync(CODEX_CONFIG)) {
    const raw = await readFile(CODEX_CONFIG, 'utf8')
    const config = TOML.parse(raw) as Record<string, unknown>
    const providers = config.model_providers as Record<string, unknown> | undefined

    if (providers && providers[PROVIDER_ID]) {
      delete providers[PROVIDER_ID]
      // 如果 providers 空了，把整段删掉
      if (Object.keys(providers).length === 0) {
        delete config.model_providers
      }
      await writeFile(CODEX_CONFIG, TOML.stringify(config as TOML.JsonMap), 'utf8')
      removed = true
    }
  }

  if (existsSync(COPILOT_PROFILE)) {
    await unlink(COPILOT_PROFILE)
    removed = true
  }

  return { removed }
}

/**
 * 检查 Codex config 当前状态：用于 status 命令
 */
export async function inspectInstallation(): Promise<{
  configExists: boolean
  providerInstalled: boolean
  profileExists: boolean
  currentModel: string | null
  currentProvider: string | null
  isUsingCopilot: boolean
  configPath: string
  profilePath: string
}> {
  const configExists = existsSync(CODEX_CONFIG)
  const profileExists = existsSync(COPILOT_PROFILE)
  let providerInstalled = false
  let currentModel: string | null = null
  let currentProvider: string | null = null

  if (configExists) {
    try {
      const raw = await readFile(CODEX_CONFIG, 'utf8')
      const config = TOML.parse(raw) as Record<string, unknown>
      const providers = config.model_providers as Record<string, unknown> | undefined
      providerInstalled = !!providers?.[PROVIDER_ID]
      currentModel = (config.model as string) ?? null
      currentProvider = (config.model_provider as string) ?? null
    } catch {
      providerInstalled = false
    }
  }

  return {
    configExists,
    providerInstalled,
    profileExists,
    currentModel,
    currentProvider,
    isUsingCopilot: currentProvider === PROVIDER_ID,
    configPath: CODEX_CONFIG,
    profilePath: COPILOT_PROFILE,
  }
}
