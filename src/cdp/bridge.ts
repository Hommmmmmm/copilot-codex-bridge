import { CdpSession, nextCdpMessageId } from './session.js'
import { pickInjectableCodexPageTarget, listTargets, type CdpTarget } from './targets.js'

/**
 * CDP 注入桥
 * 完整复刻 CodexPlusPlus bridge.rs 的 install_bridge / build_bridge_script / 路由 binding 调用机制
 */

/** binding 名字 — 跟 CodexPlusPlus 用一样保持 ABI 兼容 */
export const BRIDGE_BINDING_NAME = 'codexSessionDeleteV2'

/** bridge 处理函数：renderer 调 window.__codexSessionDeleteBridge(path, payload) 时触发 */
export type BridgeHandler = (path: string, payload: unknown) => Promise<unknown>

/**
 * 17 行 Promise 桥（注入到 renderer 全局）
 * 跟 bridge.rs:27 build_bridge_script 字符串完全一致
 *
 * 提供 window.__codexSessionDeleteBridge(path, payload) → Promise<result>
 * 内部用 window.<bindingName>() 调到 host（CDP binding），host 处理后回调 resolve/reject
 */
export function buildBridgeScript(bindingName: string): string {
  return `(() => {
  window.__codexSessionDeleteCallbacks = new Map();
  window.__codexSessionDeleteSeq = 0;
  window.__codexSessionDeleteResolve = (id, result) => {
    const callback = window.__codexSessionDeleteCallbacks.get(id);
    if (!callback) return;
    window.__codexSessionDeleteCallbacks.delete(id);
    callback.resolve(result);
  };
  window.__codexSessionDeleteReject = (id, message) => {
    const callback = window.__codexSessionDeleteCallbacks.get(id);
    if (!callback) return;
    window.__codexSessionDeleteCallbacks.delete(id);
    callback.resolve({ status: "failed", message });
  };
  window.__codexSessionDeleteBridge = (path, payload) => new Promise((resolve) => {
    const id = String(++window.__codexSessionDeleteSeq);
    window.__codexSessionDeleteCallbacks.set(id, { resolve });
    window.${bindingName}(JSON.stringify({ id, path, payload }));
  });
})();`
}

/**
 * bridge 健康检查脚本
 * 跟 bridge.rs:55 bridge_health_check_script 一致
 *
 * 评估这段代码：bridge 存在 → 调 /backend/status → 拿到 {status:"ok"} 返回 true
 * 否则 / 超时 2s 返回 false
 */
export function bridgeHealthCheckScript(): string {
  return `(() => {
  const bridge = window.__codexSessionDeleteBridge;
  if (typeof bridge !== "function") return false;
  try {
    return Promise.race([
      Promise.resolve(bridge("/backend/status", {})).then((result) => !!result && result.status === "ok"),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
  } catch (error) {
    return false;
  }
})()`
}

/**
 * runtime_evaluate_params 跟 bridge.rs:175 一致
 */
function runtimeEvaluateParams(script: string, awaitPromise = false): Record<string, unknown> {
  return {
    expression: script,
    awaitPromise,
    allowUnsafeEvalBlockedByCSP: true,
  }
}

/**
 * 安装 bridge 到 Codex renderer
 * 完整复刻 bridge.rs:107 install_bridge：
 *   1. Runtime.enable
 *   2. Runtime.removeBinding (清残留)
 *   3. Runtime.addBinding (注册新 binding)
 *   4. Page.addScriptToEvaluateOnNewDocument(bridgeScript) + Runtime.evaluate(bridgeScript)
 *   5. 对每个 extraScript 同样两步
 *   6. 启后台循环消费 Runtime.bindingCalled 事件，路由到 handler
 *
 * 返回 CdpSession 给调用方管生命周期（关闭 / 健康检查）
 */
export async function installBridge(
  wsUrl: string,
  bindingName: string,
  handler: BridgeHandler,
  extraScripts: string[],
): Promise<CdpSession> {
  const session = await CdpSession.connect(wsUrl)

  // 路由 Runtime.bindingCalled 事件
  session.on('Runtime.bindingCalled', async (params) => {
    await routeBindingCall(session, handler, params)
  })

  // 1-3. 启用 Runtime + 注册 binding
  await session.sendCommand(1, 'Runtime.enable', {})
  await session.sendCommand(2, 'Runtime.removeBinding', { name: bindingName })
  await session.sendCommand(3, 'Runtime.addBinding', { name: bindingName })

  // 4. bridge 脚本：注入到所有未来文档 + 立即执行一次
  const bridgeScript = buildBridgeScript(bindingName)
  await session.sendCommand(4, 'Page.addScriptToEvaluateOnNewDocument', { source: bridgeScript })
  await session.sendCommand(5, 'Runtime.evaluate', runtimeEvaluateParams(bridgeScript))

  // 5. 额外脚本（如 renderer-inject.js）
  for (const script of extraScripts) {
    await session.sendCommand(nextCdpMessageId(), 'Page.addScriptToEvaluateOnNewDocument', { source: script })
    await session.sendCommand(nextCdpMessageId(), 'Runtime.evaluate', runtimeEvaluateParams(script))
  }

  return session
}

/**
 * 路由 Runtime.bindingCalled 事件 → handler
 * 跟 bridge.rs:346 route_binding_call 一致
 *
 * params 结构：{ name: bindingName, payload: '{"id":"...","path":"...","payload":...}' }
 */
async function routeBindingCall(
  session: CdpSession,
  handler: BridgeHandler,
  params: Record<string, unknown>,
): Promise<void> {
  const payloadText = params.payload
  if (typeof payloadText !== 'string') return

  let parsed: { id?: string; path?: string; payload?: unknown }
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    // 静默 — payload 解析失败但没法提取 id，跟 Rust 实现一致
    return
  }

  if (typeof parsed.id !== 'string') return

  const requestId = parsed.id
  const path = parsed.path ?? ''
  const payload = parsed.payload ?? {}

  try {
    const result = await handler(path, payload)
    await resolveBridgeRequest(session, requestId, result)
  } catch (err) {
    await rejectBridgeRequest(session, requestId, err instanceof Error ? err.message : String(err))
  }
}

/**
 * 通过 Runtime.evaluate 调 window.__codexSessionDeleteResolve(id, result) 把结果送回 renderer
 * 跟 bridge.rs:187 resolve_bridge_expression 一致
 */
async function resolveBridgeRequest(session: CdpSession, requestId: string, result: unknown): Promise<void> {
  const expr = `window.__codexSessionDeleteResolve(${JSON.stringify(requestId)}, ${JSON.stringify(result)})`
  await session.sendCommandWithoutWait(nextCdpMessageId(), 'Runtime.evaluate', runtimeEvaluateParams(expr))
}

/**
 * 通过 Runtime.evaluate 调 window.__codexSessionDeleteReject(id, message) 报错回 renderer
 * 跟 bridge.rs:195 reject_bridge_expression 一致
 */
async function rejectBridgeRequest(session: CdpSession, requestId: string, message: string): Promise<void> {
  const expr = `window.__codexSessionDeleteReject(${JSON.stringify(requestId)}, ${JSON.stringify(message)})`
  await session.sendCommandWithoutWait(nextCdpMessageId(), 'Runtime.evaluate', runtimeEvaluateParams(expr))
}

/**
 * 完整注入流程：连 CDP → 选 target → 安装 bridge → 注入额外脚本
 * 跟 launcher.rs:3533 try_inject 一致（合并了 list_targets + pick + install_bridge）
 */
export async function tryInject(
  debugPort: number,
  bindingName: string,
  handler: BridgeHandler,
  extraScripts: string[],
): Promise<{ session: CdpSession; target: CdpTarget }> {
  const targets = await listTargets(debugPort)
  const target = pickInjectableCodexPageTarget(targets)
  const wsUrl = target.webSocketDebuggerUrl
  if (!wsUrl) {
    throw new Error('selected CDP target has no websocket URL')
  }
  const session = await installBridge(wsUrl, bindingName, handler, extraScripts)
  return { session, target }
}

/**
 * 重试注入直到成功
 * 跟 launcher.rs:3443 retry_injection 一致：20 次 × 500ms
 */
export async function retryInjection(
  debugPort: number,
  bindingName: string,
  handler: BridgeHandler,
  extraScripts: string[],
  maxAttempts = 20,
  intervalMs = 500,
): Promise<{ session: CdpSession; target: CdpTarget }> {
  let lastError: Error | null = null
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await tryInject(debugPort, bindingName, handler, extraScripts)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      await sleep(intervalMs)
    }
  }
  throw lastError ?? new Error('Codex injection failed after retries')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
