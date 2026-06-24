import type { CdpSession } from './session.js'
import { bridgeHealthCheckScript } from './bridge.js'

/**
 * bridge 健康检查 + 自动重连看门狗
 * 复刻 CodexPlusPlus launcher.rs check_and_reinject_bridge 机制
 *
 * 工作原理：
 *   - 每 5 秒跑一次 bridgeHealthCheckScript
 *   - 检查 window.__codexSessionDeleteBridge 是否还能用
 *   - 失败时调用 onUnhealthy 触发重注入
 */

const HEALTH_CHECK_INTERVAL_MS = 5000

export interface HealthMonitor {
  stop(): void
}

/**
 * 启动健康检查后台任务
 * 返回 stop() 给调用方控制生命周期
 */
export function startHealthMonitor(
  session: CdpSession,
  onUnhealthy: () => Promise<void> | void,
): HealthMonitor {
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const tick = async () => {
    if (stopped) return

    let healthy = false
    if (!session.isClosed()) {
      try {
        healthy = await checkBridgeHealth(session)
      } catch {
        healthy = false
      }
    }

    if (!healthy && !stopped) {
      console.log('[copilot-bridge] bridge unhealthy, triggering reinjection')
      try {
        await onUnhealthy()
      } catch (err) {
        console.error('[copilot-bridge] reinjection failed:', err instanceof Error ? err.message : err)
      }
    }

    if (!stopped) {
      timer = setTimeout(() => void tick(), HEALTH_CHECK_INTERVAL_MS)
    }
  }

  // 启动后等一个 interval 再开始（让首次注入有时间稳定）
  timer = setTimeout(() => void tick(), HEALTH_CHECK_INTERVAL_MS)

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/**
 * 单次健康检查：跑 bridge_health_check_script 看返回值
 */
async function checkBridgeHealth(session: CdpSession): Promise<boolean> {
  if (session.isClosed()) return false

  const result = (await session.sendCommand(nextHealthCheckMessageId(), 'Runtime.evaluate', {
    expression: bridgeHealthCheckScript(),
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  })) as { result?: { result?: { value?: boolean } } } | undefined

  return result?.result?.result?.value === true
}

let healthCheckIdSeq = 9_000_000
function nextHealthCheckMessageId(): number {
  healthCheckIdSeq += 1
  return healthCheckIdSeq
}
