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
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          <span>选择模型</span>
          <span className="status-tag" style={{ color: '#475569', borderColor: '#e5e7eb' }}>
            {models.length} 个
          </span>
        </div>
        <button onClick={refreshModels} className="btn btn-sm">
          刷新
        </button>
      </div>

      {models.length === 0 ? (
        <div className="model-empty">请先启动代理（点上方 “启动” 按钮）</div>
      ) : (
        <div className="model-grid">
          {models.map((m) => {
            const isSelected = selected === m.id
            const isCurrent = codex.currentModel === m.id
            return (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                className={`model-tile ${isSelected ? 'model-tile-selected' : ''}`}
              >
                <div className="model-tile-name">
                  {m.name}
                  {isCurrent && <span className="tag-current">当前</span>}
                </div>
                <div className="model-tile-id">{m.id}</div>
              </button>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => selected && onApply(selected)}
          disabled={!selected || applying}
          className="btn btn-primary"
        >
          {applying ? '应用中（重启 Codex.app）…' : `应用并重启 Codex${selected ? `: ${selected}` : ''}`}
        </button>
      </div>
    </div>
  )
}
