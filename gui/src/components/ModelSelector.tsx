// 模型选择器：列表 + 选中态 + 应用按钮
import { useEffect, useState } from 'react'
import { useBridgeStore } from '../lib/store'

export function ModelSelector({
  onApply,
  applying,
}: {
  onApply: (model: string) => void
  applying: boolean
}) {
  const { models, codex, refreshModels } = useBridgeStore()
  const [selected, setSelected] = useState<string | null>(null)

  // 当前 model 优先；否则选第一个
  useEffect(() => {
    if (!selected && codex.currentModel) setSelected(codex.currentModel)
    else if (!selected && models.length > 0) setSelected(models[0].id)
  }, [codex.currentModel, models, selected])

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#374151' }}>
          选择模型 ({models.length} 个可用)
        </h3>
        <button
          onClick={refreshModels}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            border: '1px solid #e5e7eb',
            background: '#f9fafb',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          刷新
        </button>
      </div>

      {models.length === 0 ? (
        <div style={{ color: '#9ca3af', fontSize: 13, padding: '16px 0' }}>
          请先启动代理（点上方"启动"按钮）
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {models.map((m) => {
            const isSelected = selected === m.id
            const isCurrent = codex.currentModel === m.id
            return (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                style={{
                  textAlign: 'left',
                  padding: 10,
                  borderRadius: 8,
                  border: `1px solid ${isSelected ? '#2563eb' : '#e5e7eb'}`,
                  background: isSelected ? '#eff6ff' : '#fff',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500, color: '#111' }}>
                  {m.name}
                  {isCurrent && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        padding: '1px 4px',
                        background: '#22c55e',
                        color: '#fff',
                        borderRadius: 3,
                      }}
                    >
                      当前
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{m.id}</div>
              </button>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => selected && onApply(selected)}
          disabled={!selected || applying}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: !selected || applying ? '#9ca3af' : '#2563eb',
            color: '#fff',
            fontSize: 13,
            fontWeight: 500,
            cursor: !selected || applying ? 'wait' : 'pointer',
          }}
        >
          {applying ? '应用中（重启 Codex.app）...' : `应用并重启 Codex${selected ? `: ${selected}` : ''}`}
        </button>
      </div>
    </div>
  )
}
