// 全局状态：zustand store
// 订阅 Tauri 事件（stdout/stderr）+ 暴露所有状态给组件
import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import {
  type CodexStatus,
  type LoginStatus,
  type ModelInfo,
  type ProxyStatus,
  getCodexStatus,
  getLoginStatus,
  getProxyStatus,
  listModels,
} from './api'

export type LogSource = 'proxy' | 'launch' | 'login' | 'install'

export interface LogEntry {
  source: LogSource
  channel: 'stdout' | 'stderr'
  ts: number
  text: string
}

interface BridgeState {
  login: LoginStatus
  proxy: ProxyStatus
  codex: CodexStatus
  models: ModelInfo[]
  logs: LogEntry[]
  selectedLogSource: LogSource | 'all'

  // 操作
  refreshAll: () => Promise<void>
  refreshLogin: () => Promise<void>
  refreshProxy: () => Promise<void>
  refreshCodex: () => Promise<void>
  refreshModels: () => Promise<void>
  appendLog: (entry: LogEntry) => void
  setLogSource: (s: LogSource | 'all') => void
  clearLogs: () => void
}

const MAX_LOGS = 1000

export const useBridgeStore = create<BridgeState>((set, get) => ({
  login: { authenticated: false, expiresAt: 0, remainingMinutes: 0 },
  proxy: { running: false, pid: null, port: 8787, host: '127.0.0.1', lanIps: [] },
  codex: { launchRunning: false, launchPid: null, currentModel: null },
  models: [],
  logs: [],
  selectedLogSource: 'all',

  refreshAll: async () => {
    await Promise.all([
      get().refreshLogin(),
      get().refreshProxy(),
      get().refreshCodex(),
    ])
    // 模型列表只在代理跑起来后才能拉
    if (get().proxy.running) await get().refreshModels()
  },

  refreshLogin: async () => {
    try {
      const s = await getLoginStatus()
      set({ login: s })
    } catch {
      // 忽略
    }
  },

  refreshProxy: async () => {
    try {
      const s = await getProxyStatus()
      set({ proxy: s })
    } catch {
      // 忽略
    }
  },

  refreshCodex: async () => {
    try {
      const s = await getCodexStatus()
      set({ codex: s })
    } catch {
      // 忽略
    }
  },

  refreshModels: async () => {
    try {
      const ms = await listModels()
      set({ models: ms })
    } catch {
      // 代理没跑起来时会失败，正常
    }
  },

  appendLog: (entry) => {
    const logs = [...get().logs, entry].slice(-MAX_LOGS)
    set({ logs })
  },

  setLogSource: (s) => set({ selectedLogSource: s }),
  clearLogs: () => set({ logs: [] }),
}))

/**
 * 启动时调用一次：订阅所有 Tauri 事件
 * 4 个进程源 × 2 个 channel = 8 个监听器
 */
let installed = false
export async function setupEventListeners() {
  if (installed) return
  installed = true

  const sources: LogSource[] = ['proxy', 'launch', 'login', 'install']
  const channels: ('stdout' | 'stderr')[] = ['stdout', 'stderr']

  for (const source of sources) {
    for (const channel of channels) {
      const evt = `${source}://${channel}`
      await listen<string>(evt, (e) => {
        useBridgeStore.getState().appendLog({
          source,
          channel,
          ts: Date.now(),
          text: e.payload,
        })
      })
    }
  }
}
