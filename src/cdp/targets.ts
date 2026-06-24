/**
 * Chrome DevTools Protocol target 发现
 * 完整复刻 CodexPlusPlus 的 cdp.rs
 *
 * 流程：GET http://127.0.0.1:9229/json → 拿 CdpTarget 列表 → 选 page 类型且 URL 含 codex 的
 */

export interface CdpTarget {
  id: string
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

/** 跟 cdp.rs:5 一致：HTTP 超时 3 秒 */
const CDP_HTTP_TIMEOUT_MS = 3000

/**
 * 列出指定端口的 CDP targets
 * 跟 cdp.rs:20 一致：IPv4 / IPv6 各试一次，都失败抛错
 */
export async function listTargets(debugPort: number): Promise<CdpTarget[]> {
  const urls = [
    `http://127.0.0.1:${debugPort}/json`,
    `http://[::1]:${debugPort}/json`,
  ]
  const errors: string[] = []

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS) })
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as CdpTarget[]
      return data
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  throw new Error(`failed to query CDP targets on loopback: ${errors.join('; ')}`)
}

/**
 * 选可注入的 page target：必须是 page 类型 + 有 webSocketDebuggerUrl + URL/title 含 codex
 * 跟 cdp.rs:79 pick_injectable_codex_page_target 一致
 */
export function pickInjectableCodexPageTarget(targets: CdpTarget[]): CdpTarget {
  for (const t of targets) {
    if (!isInjectablePageTarget(t)) continue
    if (isCodexPageTarget(t)) return t
  }
  throw new Error('No injectable Codex page target found')
}

function isInjectablePageTarget(t: CdpTarget): boolean {
  return t.type === 'page' && !!t.webSocketDebuggerUrl && t.webSocketDebuggerUrl.length > 0
}

function isCodexPageTarget(t: CdpTarget): boolean {
  if (t.type !== 'page') return false
  const haystack = `${t.title ?? ''} ${t.url ?? ''}`.toLowerCase()
  return haystack.includes('codex')
}
