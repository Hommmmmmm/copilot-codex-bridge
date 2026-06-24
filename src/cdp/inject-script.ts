import embeddedInjectScript from '../inject/renderer-inject.embedded.js'

/**
 * 拼接注入到 Codex.app renderer 的完整脚本
 *
 * renderer-inject.js 在 build 时由 scripts/embed-inject.mjs 转成 TS 模块内联进
 * bundle，运行时无需再去磁盘读文件——这样 bun --compile 出的单二进制 sidecar
 * 也能用。
 */

let cachedScript: string | null = null

export async function loadInjectionScript(apiBase = 'http://127.0.0.1:8787'): Promise<string> {
  if (cachedScript) return cachedScript

  const preamble = `window.__COPILOT_BRIDGE_API_BASE__ = ${JSON.stringify(apiBase)};\nwindow.__COPILOT_BRIDGE_VERSION__ = "0.2.0";\n`

  cachedScript = preamble + embeddedInjectScript
  return cachedScript
}

/** 清缓存（开发调试用） */
export function clearInjectionScriptCache(): void {
  cachedScript = null
}
