// 状态卡片：3 张并排（认证 / 代理 / Codex 注入）
import type { CSSProperties, ReactNode } from 'react'
import { useBridgeStore } from '../lib/store'

interface CardProps {
  title: string
  status: 'ok' | 'warn' | 'error' | 'idle'
  primary: string
  secondary?: string
  children?: ReactNode
}

function Card({ title, status, primary, secondary, children }: CardProps) {
  const dot = {
    ok: '#22c55e',
    warn: '#eab308',
    error: '#ef4444',
    idle: '#9ca3af',
  }[status]
  return (
    <div
      style={{
        flex: 1,
        background: '#fff',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#6b7280' }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dot,
            display: 'inline-block',
          }}
        />
        {title}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: '#111' }}>{primary}</div>
      {secondary && <div style={{ fontSize: 12, color: '#6b7280' }}>{secondary}</div>}
      {children}
    </div>
  )
}

const btnStyle: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid #e5e7eb',
  background: '#f9fafb',
  cursor: 'pointer',
}

const dangerBtnStyle: CSSProperties = {
  ...btnStyle,
  borderColor: '#fecaca',
  background: '#fef2f2',
  color: '#b91c1c',
}

interface Props {
  onLogin: () => void
  onLogout: () => void
  onStartProxy: () => void
  onStopProxy: () => void
  proxyPort: number
  onPortChange: (port: number) => void
  busy: Record<string, boolean>
}

export function StatusCards({
  onLogin,
  onLogout,
  onStartProxy,
  onStopProxy,
  proxyPort,
  onPortChange,
  busy,
}: Props) {
  const { login, proxy, codex } = useBridgeStore()

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {/* 卡片 1：GitHub 授权（含登录 + 退出按钮） */}
      <Card
        title="GitHub 授权"
        status={login.authenticated && login.remainingMinutes > 0 ? 'ok' : login.authenticated ? 'warn' : 'error'}
        primary={
          login.authenticated
            ? login.remainingMinutes > 0
              ? `Token 剩余 ${login.remainingMinutes} 分钟`
              : 'Token 已过期'
            : '未授权'
        }
        secondary={login.authenticated ? '到期会自动续期' : '请先登录 Copilot'}
      >
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button
            onClick={onLogin}
            disabled={busy.login}
            style={{ ...btnStyle, cursor: busy.login ? 'wait' : 'pointer' }}
          >
            {busy.login ? '...' : login.authenticated ? '重新登录' : '登录'}
          </button>
          {login.authenticated && (
            <button
              onClick={onLogout}
              disabled={busy.logout}
              style={{ ...dangerBtnStyle, cursor: busy.logout ? 'wait' : 'pointer' }}
            >
              {busy.logout ? '...' : '退出'}
            </button>
          )}
        </div>
      </Card>

      {/* 卡片 2：本地代理（含端口输入 + 启停） */}
      <Card
        title="本地代理"
        status={proxy.running ? 'ok' : 'idle'}
        primary={proxy.running ? `运行中 :${proxy.port}` : '未运行'}
        secondary={proxy.pid ? `PID ${proxy.pid}` : '设置端口后启动'}
      >
        <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
          <label style={{ fontSize: 11, color: '#6b7280' }}>端口</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={proxyPort}
            disabled={proxy.running}
            onChange={(e) => onPortChange(Number(e.target.value) || 8787)}
            style={{
              width: 60,
              padding: '2px 6px',
              fontSize: 11,
              border: '1px solid #e5e7eb',
              borderRadius: 4,
              background: proxy.running ? '#f3f4f6' : '#fff',
            }}
          />
          {proxy.running ? (
            <button
              onClick={onStopProxy}
              disabled={busy.proxyStop}
              style={{ ...btnStyle, cursor: busy.proxyStop ? 'wait' : 'pointer' }}
            >
              {busy.proxyStop ? '...' : '停止'}
            </button>
          ) : (
            <button
              onClick={onStartProxy}
              disabled={busy.proxyStart}
              style={{ ...btnStyle, cursor: busy.proxyStart ? 'wait' : 'pointer' }}
            >
              {busy.proxyStart ? '...' : '启动'}
            </button>
          )}
        </div>
      </Card>

      {/* 卡片 3：Codex 注入 */}
      <Card
        title="Codex 注入"
        status={codex.launchRunning ? 'ok' : 'idle'}
        primary={codex.launchRunning ? '注入运行中' : '未启动'}
        secondary={codex.currentModel ? `当前模型: ${codex.currentModel}` : '选模型后启动'}
      />
    </div>
  )
}
