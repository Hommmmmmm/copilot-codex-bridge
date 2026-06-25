// 状态卡片：3 张并排（认证 / 代理 / Codex 注入）
import type { ReactNode } from 'react'
import { useBridgeStore } from '../lib/store'

type Status = 'ok' | 'warn' | 'error' | 'idle'

interface CardProps {
  title: string
  status: Status
  primary: string
  secondary?: string
  children?: ReactNode
}

const STATUS_COLOR: Record<Status, string> = {
  ok: '#16a34a',
  warn: '#f59e0b',
  error: '#ef4444',
  idle: '#9ca3af',
}

const STATUS_LABEL: Record<Status, string> = {
  ok: '正常',
  warn: '注意',
  error: '异常',
  idle: '待启动',
}

function Card({ title, status, primary, secondary, children }: CardProps) {
  const color = STATUS_COLOR[status]
  return (
    <div className="card status-card">
      <div className="status-card-head">
        <span className="status-dot" style={{ background: color }} />
        <span className="status-card-title">{title}</span>
        <span
          className="status-tag"
          style={{ color, borderColor: color + '33' }}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div className="status-card-primary">{primary}</div>
      {secondary && <div className="status-card-secondary">{secondary}</div>}
      <div className="status-card-footer">{children}</div>
    </div>
  )
}

interface Props {
  onLogin: () => void
  onLogout: () => void
  onStartProxy: () => void
  onStopProxy: () => void
  proxyPort: number
  onPortChange: (port: number) => void
  exposeLan: boolean
  onExposeLanChange: (next: boolean) => void
  busy: Record<string, boolean>
}

export function StatusCards({
  onLogin,
  onLogout,
  onStartProxy,
  onStopProxy,
  proxyPort,
  onPortChange,
  exposeLan,
  onExposeLanChange,
  busy,
}: Props) {
  const { login, proxy, codex } = useBridgeStore()

  const loginStatus: Status =
    login.authenticated && login.remainingMinutes > 0
      ? 'ok'
      : login.authenticated
        ? 'warn'
        : 'error'

  return (
    <div className="status-cards">
      {/* 卡片 1：GitHub 授权（含登录 + 退出按钮） */}
      <Card
        title="GitHub 授权"
        status={loginStatus}
        primary={
          login.authenticated
            ? login.remainingMinutes > 0
              ? `Token 剩余 ${login.remainingMinutes} 分钟`
              : 'Token 已过期'
            : '未授权'
        }
        secondary={login.authenticated ? '到期会自动续期' : '请先登录 Copilot'}
      >
        <button
          onClick={onLogin}
          disabled={busy.login}
          className="btn btn-sm"
        >
          {busy.login ? '...' : login.authenticated ? '重新登录' : '登录'}
        </button>
        {login.authenticated && (
          <button
            onClick={onLogout}
            disabled={busy.logout}
            className="btn btn-sm btn-danger"
          >
            {busy.logout ? '...' : '退出'}
          </button>
        )}
      </Card>

      {/* 卡片 2：本地代理（含端口输入 + 启停 + 局域网开关 + LAN 地址） */}
      <Card
        title="本地代理"
        status={proxy.running ? 'ok' : 'idle'}
        primary={
          proxy.running
            ? proxy.host === '0.0.0.0'
              ? `运行中 :${proxy.port}（局域网）`
              : `运行中 :${proxy.port}`
            : '未运行'
        }
        secondary={proxy.pid ? `PID ${proxy.pid}` : '设置端口后启动'}
      >
        <label className="port-label">端口</label>
        <input
          type="number"
          min={1024}
          max={65535}
          value={proxyPort}
          disabled={proxy.running}
          onChange={(e) => onPortChange(Number(e.target.value) || 8787)}
          className="port-input"
        />
        {proxy.running ? (
          <button
            onClick={onStopProxy}
            disabled={busy.proxyStop}
            className="btn btn-sm"
          >
            {busy.proxyStop ? '...' : '停止'}
          </button>
        ) : (
          <button
            onClick={onStartProxy}
            disabled={busy.proxyStart}
            className="btn btn-sm btn-primary"
          >
            {busy.proxyStart ? '...' : '启动'}
          </button>
        )}
        <ExposeLanToggle
          checked={exposeLan}
          disabled={proxy.running}
          onChange={onExposeLanChange}
        />
        {proxy.running && proxy.host === '0.0.0.0' && proxy.lanIps.length > 0 && (
          <LanAddressList port={proxy.port} ips={proxy.lanIps} />
        )}
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

/** 「开放到局域网」开关 —— 决定下次 start 时 bind 0.0.0.0 还是 127.0.0.1 */
function ExposeLanToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label
      className="lan-toggle"
      title={
        disabled
          ? '代理运行中无法切换，先停止代理'
          : '开启后下次启动监听 0.0.0.0，同局域网设备可访问'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="lan-toggle-text">开放到局域网</span>
    </label>
  )
}

/** 列出 http://<lan-ip>:port/v1 供局域网内其他设备复制使用 */
function LanAddressList({ port, ips }: { port: number; ips: string[] }) {
  return (
    <div className="lan-addresses">
      <span className="lan-addresses-label">局域网地址</span>
      {ips.map((ip) => {
        const url = `http://${ip}:${port}/v1`
        return (
          <button
            key={ip}
            type="button"
            className="lan-address-pill"
            onClick={() => {
              void navigator.clipboard?.writeText(url)
            }}
            title="点击复制"
          >
            {url}
          </button>
        )
      })}
    </div>
  )
}
