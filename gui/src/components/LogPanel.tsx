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
    <div className="card log-panel">
      <div className="card-head">
        <div className="card-title">日志</div>
        <div className="log-tabs">
          {(['all', 'proxy', 'launch', 'login', 'install'] as const).map((src) => {
            const active = selectedLogSource === src
            return (
              <button
                key={src}
                onClick={() => setLogSource(src)}
                className={`log-tab ${active ? 'log-tab-active' : ''}`}
              >
                {SOURCE_LABELS[src]}
              </button>
            )
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={clearLogs} className="btn btn-sm">
          清空
        </button>
      </div>

      <div ref={containerRef} className="log-viewer">
        {filtered.length === 0 ? (
          <div className="log-empty">暂无日志…</div>
        ) : (
          filtered.map((entry, i) => {
            const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })
            const color = entry.channel === 'stderr' ? '#fca5a5' : '#a7f3d0'
            return (
              <div key={i} style={{ marginBottom: 2 }}>
                <span style={{ color: '#64748b' }}>{time} </span>
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
