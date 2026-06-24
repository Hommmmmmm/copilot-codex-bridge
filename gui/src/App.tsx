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
const DEFAULT_PORT = 8787

function loadPort(): number {
  const raw = localStorage.getItem(PROXY_PORT_KEY)
  if (!raw) return DEFAULT_PORT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT
}

export default function App() {
  const refreshAll = useBridgeStore((s) => s.refreshAll)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [proxyPort, setProxyPort] = useState<number>(loadPort)

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

  const onLogin = () => {
    alert('[gui] 点击登录')
    console.log('[gui] 点击登录')
    wrap('login', () => apiRunLogin())
  }
  const onLogout = async () => {
    alert('[gui] 点击退出')
    console.log('[gui] 点击退出')
    const yes = await ask('确定退出 Copilot 授权？退出后需要重新登录才能使用', {
      title: '确认退出',
      kind: 'warning',
    })
    if (yes) {
      wrap('logout', () => apiRunLogout())
    }
  }
  const onStartProxy = () => {
    console.log('[gui] 启动代理 port=', proxyPort)
    wrap('proxyStart', () => apiStartProxy(proxyPort))
  }
  const onStopProxy = () => {
    console.log('[gui] 停止代理')
    wrap('proxyStop', () => apiStopProxy())
  }
  const onApplyModel = (model: string) => {
    console.log('[gui] 应用模型', model)
    wrap('launch', () => apiLaunchCodex(model))
  }

  return (
    <div
      style={{
        background: '#f3f4f6',
        height: '100vh',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxSizing: 'border-box',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 20, color: '#111' }}>Copilot Codex Bridge</h1>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>
          GitHub Copilot 模型 → Codex.app 桌面端
        </span>
      </header>

      <StatusCards
        onLogin={onLogin}
        onLogout={onLogout}
        onStartProxy={onStartProxy}
        onStopProxy={onStopProxy}
        proxyPort={proxyPort}
        onPortChange={onPortChange}
        busy={busy}
      />

      <ModelSelector onApply={onApplyModel} applying={!!busy.launch} />

      <LogPanel />
    </div>
  )
}
