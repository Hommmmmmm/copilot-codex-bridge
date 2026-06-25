// 主 App 组件：调度状态轮询 + 装订事件 + 布局
import { useCallback, useEffect, useState } from 'react'
import { ask } from '@tauri-apps/plugin-dialog'
import './App.css'
import { LogPanel } from './components/LogPanel'
import { ModelSelector } from './components/ModelSelector'
import { StatusCards } from './components/StatusCards'
import {
  launchCodex as apiLaunchCodex,
  runLogin as apiRunLogin,
  runLogout as apiRunLogout,
  startProxy as apiStartProxy,
  stopProxy as apiStopProxy,
} from './lib/api'
import { setupEventListeners, useBridgeStore } from './lib/store'

const PROXY_PORT_KEY = 'copilot-bridge:proxy-port'
const PROXY_EXPOSE_LAN_KEY = 'copilot-bridge:proxy-expose-lan'
const DEFAULT_PORT = 8787

function loadPort(): number {
  const raw = localStorage.getItem(PROXY_PORT_KEY)
  if (!raw) return DEFAULT_PORT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT
}

function loadExposeLan(): boolean {
  return localStorage.getItem(PROXY_EXPOSE_LAN_KEY) === '1'
}

export default function App() {
  const refreshAll = useBridgeStore((s) => s.refreshAll)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [proxyPort, setProxyPort] = useState<number>(loadPort)
  const [exposeLan, setExposeLan] = useState<boolean>(loadExposeLan)

  // 启动时挂事件 listener + 首次刷新
  useEffect(() => {
    setupEventListeners()
    refreshAll()
    // 每 5 秒轮询一次状态
    const t = setInterval(() => {
      refreshAll()
    }, 5000)
    return () => clearInterval(t)
  }, [refreshAll])

  const wrap = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy((b) => ({ ...b, [key]: true }))
      try {
        await fn()
      } catch (err) {
        console.error(`[${key}] failed:`, err)
      } finally {
        setBusy((b) => ({ ...b, [key]: false }))
        await refreshAll()
      }
    },
    [refreshAll],
  )

  const onPortChange = (port: number) => {
    setProxyPort(port)
    localStorage.setItem(PROXY_PORT_KEY, String(port))
  }

  const onExposeLanChange = (next: boolean) => {
    setExposeLan(next)
    localStorage.setItem(PROXY_EXPOSE_LAN_KEY, next ? '1' : '0')
  }

  const onLogin = () => {
    wrap('login', () => apiRunLogin())
  }
  const onLogout = async () => {
    const yes = await ask('确定退出 Copilot 授权？退出后需要重新登录才能使用。', {
      title: '确认退出',
      kind: 'warning',
    })
    if (yes) {
      wrap('logout', () => apiRunLogout())
    }
  }
  const onStartProxy = () => {
    wrap('proxyStart', () => apiStartProxy(proxyPort, exposeLan))
  }
  const onStopProxy = () => {
    wrap('proxyStop', () => apiStopProxy())
  }
  const onApplyModel = (model: string) => {
    wrap('launch', () => apiLaunchCodex(model))
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-header-title">
          <h1>Copilot Codex Bridge</h1>
          <span className="subtitle">GitHub Copilot 模型 → Codex.app 桌面端</span>
        </div>
        <span className="app-header-meta">v0.1.0</span>
      </header>

      <StatusCards
        onLogin={onLogin}
        onLogout={onLogout}
        onStartProxy={onStartProxy}
        onStopProxy={onStopProxy}
        proxyPort={proxyPort}
        onPortChange={onPortChange}
        exposeLan={exposeLan}
        onExposeLanChange={onExposeLanChange}
        busy={busy}
      />

      <ModelSelector onApply={onApplyModel} applying={!!busy.launch} />

      <LogPanel />
    </div>
  )
}
