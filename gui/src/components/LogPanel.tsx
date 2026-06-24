// 日志面板：实时滚动 + 按源切换 tab
import { useEffect, useRef } from 'react'
import { useBridgeStore, type LogSource } from '../lib/store'

const SOURCE_LABELS: Record<LogSource | 'all', string> = {
  all: '全部',
  proxy: '代理',
  launch: 'launch',
  login: '登录',
  install: '安装',
}

export function LogPanel() {
  const { logs, selectedLogSource, setLogSource, clearLogs } = useBridgeStore()
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered =
    selectedLogSource === 'all' ? logs : logs.filter((l) => l.source === selectedLogSource)

  // 自动滚动到底部
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filtered.length])

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#374151' }}>日志</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'proxy', 'launch', 'login', 'install'] as const).map((src) => {
            const active = selectedLogSource === src
            return (
              <button
                key={src}
                onClick={() => setLogSource(src)}
                style={{
                  fontSize: 11,
                  padding: '3px 10px',
                  borderRadius: 4,
                  border: 'none',
                  background: active ? '#2563eb' : '#f3f4f6',
                  color: active ? '#fff' : '#6b7280',
                  cursor: 'pointer',
                }}
              >
                {SOURCE_LABELS[src]}
              </button>
            )
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={clearLogs}
          style={{
            fontSize: 11,
            padding: '3px 10px',
            border: '1px solid #e5e7eb',
            background: '#fff',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          清空
        </button>
      </div>

      <div
        ref={containerRef}
        style={{
          flex: 1,
          background: '#1f2937',
          color: '#d1d5db',
          fontFamily: 'Menlo, Monaco, monospace',
          fontSize: 11,
          padding: 12,
          borderRadius: 8,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ color: '#6b7280' }}>暂无日志...</div>
        ) : (
          filtered.map((entry, i) => {
            const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })
            const color = entry.channel === 'stderr' ? '#fca5a5' : '#a7f3d0'
            return (
              <div key={i} style={{ marginBottom: 2 }}>
                <span style={{ color: '#9ca3af' }}>{time} </span>
                <span style={{ color: '#60a5fa' }}>[{entry.source}] </span>
                <span style={{ color }}>{entry.text}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
