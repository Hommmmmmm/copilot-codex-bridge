// Tauri IPC 封装：所有 invoke 调用走这里，统一类型 + 错误处理
import { invoke } from '@tauri-apps/api/core'

export interface LoginStatus {
  authenticated: boolean
  expiresAt: number
  remainingMinutes: number
}

export interface ProxyStatus {
  running: boolean
  pid: number | null
  port: number
}

export interface CodexStatus {
  launchRunning: boolean
  launchPid: number | null
  currentModel: string | null
}

export interface OpStatus {
  status: string
  message: string
}

export interface ModelInfo {
  id: string
  name: string
  category: string | null
}

// 状态查询
export const getLoginStatus = () => invoke<LoginStatus>('login_status')
export const getProxyStatus = () => invoke<ProxyStatus>('proxy_status')
export const getCodexStatus = () => invoke<CodexStatus>('codex_status')

// 代理控制（port 可选；不传走 CLI 默认 8787）
export const startProxy = (port?: number) => invoke<OpStatus>('start_proxy', { port })
export const stopProxy = () => invoke<OpStatus>('stop_proxy')

// 模型 / Codex 控制
export const listModels = () => invoke<ModelInfo[]>('list_models')
export const launchCodex = (model: string) => invoke<OpStatus>('launch_codex', { model })
export const stopCodex = () => invoke<OpStatus>('stop_codex')

// 一次性操作
export const runLogin = () => invoke<OpStatus>('run_login')
export const runLogout = () => invoke<OpStatus>('run_logout')
export const runInstall = () => invoke<OpStatus>('run_install')
