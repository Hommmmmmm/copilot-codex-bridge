import embeddedInjectScript from '../inject/renderer-inject.embedded.js'

/**
 * 拼接注入到 Codex.app renderer 的完整脚本
 *
 * renderer-inject.js 在 build 时由 scripts/embed-inject.mjs 转成 TS 模块内联进
 * bundle，运行时无需再去磁盘读文件——这样 bun --compile 出的单二进制 sidecar
 * 也能用。
 *
 * preamble 注入 2 个全局：
 *   __COPILOT_BRIDGE_API_BASE__   代理 base URL，给 inject 脚本拉模型用
 *   __COPILOT_BRIDGE_VERSION__    诊断
 */

export interface InjectionOptions {
  apiBase?: string
}

let cachedScript: string | null = null
let cachedOptionsKey = ''

export async function loadInjectionScript(options: InjectionOptions = {}): Promise<string> {
  const apiBase = options.apiBase ?? 'http://127.0.0.1:8787'
  if (cachedScript && cachedOptionsKey === apiBase) return cachedScript

  const preamble = [
    `window.__COPILOT_BRIDGE_API_BASE__ = ${JSON.stringify(apiBase)};`,
    `window.__COPILOT_BRIDGE_VERSION__ = "0.2.0";`,
    '',
  ].join('\n')

  cachedScript = preamble + embeddedInjectScript
  cachedOptionsKey = apiBase
  return cachedScript
}

/** 清缓存（开发调试用） */
export function clearInjectionScriptCache(): void {
  cachedScript = null
  cachedOptionsKey = ''
}
