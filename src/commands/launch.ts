import { spawn } from 'node:child_process'
import { ensureProviderConfig, switchModel } from '../codex/config.js'
import { listCopilotModels, filterUsableChatModels } from '../copilot/models.js'
import { retryInjection, BRIDGE_BINDING_NAME, type BridgeHandler } from '../cdp/bridge.js'
import { loadInjectionScript } from '../cdp/inject-script.js'

/**
 * launch 命令：一键切换模型 + 重启 Codex.app + CDP 注入菜单 patch
 *
 * 流程：
 *   1. switchModel(model)             改 config.toml
 *   2. quit Codex.app                 温柔退出
 *   3. 用 --remote-debugging-port=9229 启动 Codex.app
 *   4. retry 注入 renderer-inject.js   让菜单显示自定义模型
 *   5. 启动健康监控                    掉线自动重注入
 */

const DEBUG_PORT = 9229
const CODEX_APP_PATH = '/Applications/Codex.app'

export async function launchCommand(modelArg: string | undefined): Promise<void> {
  // 拉模型列表用于校验
  const all = await listCopilotModels()
  const usable = filterUsableChatModels(all)
  const usableIds = new Set(usable.map((m) => m.id))

  if (!modelArg) {
    console.log('用法：copilot-bridge launch <model-id>')
    console.log('')
    console.log('可用模型：')
    for (const m of usable) {
      const tag = m.model_picker_category ? ` [${m.model_picker_category}]` : ''
      console.log(`  ${m.id.padEnd(28)} ${m.name ?? ''}${tag}`)
    }
    return
  }

  if (!usableIds.has(modelArg)) {
    console.error(`模型 "${modelArg}" 不在可用列表里`)
    console.error('运行 `copilot-bridge launch` 不带参数可列出全部')
    process.exitCode = 1
    return
  }

  // 步骤 1：强制覆盖 config.toml 关键字段（防 cc-switch 等管理工具篡改 base_url）
  const ensured = await ensureProviderConfig(8787, modelArg)
  if (ensured.fixedBaseUrl) {
    console.log('⚠ 检测到 copilot_proxy.base_url 被外部修改，已强制还原为 http://127.0.0.1:8787/v1')
  }

  // 步骤 1.5：改 config.toml 顶层 model（switchModel 内部会再校验一次）
  const { previousModel } = await switchModel(modelArg)
  console.log(`已切换模型: ${previousModel ?? '(无)'} → ${modelArg}`)

  // 步骤 2：温柔退出 Codex.app（先 osascript quit，再 pkill 兜底）
  console.log('正在退出 Codex.app...')
  await runCommand('osascript', ['-e', 'tell application "Codex" to quit'])
  await waitForCodexExit(5000)
  // 兜底：如果 osascript 没干掉（比如 Codex 是被命令行起的、不是 GUI），强制 kill
  await runCommand('pkill', ['-f', '/Applications/Codex.app/Contents/MacOS/Codex'])
  await waitForCodexExit(3000)

  // 步骤 3：用 CDP 端口启动 Codex.app
  // 参考 CodexPlusPlus launcher.rs build_macos_open_command（line 3560）
  // 不用 -W：那会让 open 等 Codex 退出才返回，我们要立即继续
  console.log(`正在启动 Codex.app（CDP port=${DEBUG_PORT}）...`)
  await runCommand('open', [
    '-a',
    CODEX_APP_PATH,
    '--args',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--remote-allow-origins=http://127.0.0.1:${DEBUG_PORT}`,
  ])

  // 步骤 4：retry 注入（CodexPlusPlus 风格：20 次 × 500ms）
  console.log('等待 Codex 启动 + 注入菜单 patch...')
  const handler: BridgeHandler = async (path, _payload) => {
    // /backend/status — 健康检查
    if (path === '/backend/status') return { status: 'ok' }

    // /model-catalog — renderer 注入的 JS 通过 CDP bridge 来拿模型列表
    // （renderer fetch http://127.0.0.1:8787 会被 Codex CSP 拦截，所以走 bridge）
    if (path === '/model-catalog') {
      try {
        const allModels = await listCopilotModels()
        const usableModels = filterUsableChatModels(allModels)
        const categoryOrder: Record<string, number> = { powerful: 0, versatile: 1, lightweight: 2 }
        const sorted = [...usableModels].sort((a, b) => {
          const ca = categoryOrder[a.model_picker_category ?? ''] ?? 99
          const cb = categoryOrder[b.model_picker_category ?? ''] ?? 99
          if (ca !== cb) return ca - cb
          return a.id.localeCompare(b.id)
        })
        const modelIds = sorted.map((m) => m.id)
        const defaultModel =
          modelIds.find((id) => id === 'claude-opus-4.7') ??
          modelIds.find((id) => id === 'gpt-5.4') ??
          modelIds[0] ??
          ''
        return {
          status: 'ok',
          model: defaultModel,
          default_model: defaultModel,
          model_provider: 'copilot_proxy',
          provider_name: 'Copilot via local proxy',
          models: modelIds,
          sources: [],
          responses_api: { status: 'ok', message: '' },
        }
      } catch (err) {
        return {
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
          models: [],
        }
      }
    }

    return { status: 'failed', message: `unknown bridge path: ${path}` }
  }

  const injectionScript = await loadInjectionScript()
  // Codex.app 启动较慢（10-20s），retry 60 次 × 500ms = 30s 兜底
  const { session } = await retryInjection(DEBUG_PORT, BRIDGE_BINDING_NAME, handler, [injectionScript], 60, 500)
  console.log('✓ 菜单 patch 已注入')

  // 步骤 5：保持 CDP session 开着（让 bridge 能处理 renderer 的 /model-catalog 调用）
  // 但不做主动健康监控 — 避免长跑的 CDP 连接累积导致端口耗尽
  // launch 命令的 stdin 会让 process 保持活跃；session 会随 process 退出自动断开
  console.log('完成。Codex 已用新模型启动 + 菜单已 patched。')
  console.log('保持 launch 命令运行以服务 CDP bridge 请求；Ctrl+C 退出后 bridge 也停止。')

  // 阻止 process 退出 — bridge handler 需要 session 活着才能响应 renderer 的 /model-catalog
  await new Promise<void>(() => {
    // 永不 resolve；等用户 Ctrl+C
  })

  // 不会跑到这里，但保留以防万一
  session.close()
}

/** 简单的 spawn 包装，等命令退出 */
function runCommand(cmd: string, args: string[], opts: { detached?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: opts.detached ?? false,
    })
    if (opts.detached) {
      child.unref()
      resolve()
      return
    }
    child.on('exit', () => resolve())
    child.on('error', reject)
  })
}

/** 轮询直到 Codex 进程消失或超时 */
async function waitForCodexExit(timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const running = await isCodexRunning()
    if (!running) return
    await sleep(200)
  }
}

function isCodexRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('pgrep', ['-f', '/Applications/Codex.app/Contents/MacOS/Codex'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let hasOutput = false
    child.stdout?.on('data', () => {
      hasOutput = true
    })
    child.on('exit', () => resolve(hasOutput))
    child.on('error', () => resolve(false))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
