import { WebSocket, type RawData } from 'ws'

/**
 * CDP WebSocket session
 * 复刻 CodexPlusPlus bridge.rs 的 CdpSession 结构
 *
 * 核心功能：
 *  - sendCommand: 发 JSON-RPC + 等响应（带 5s 超时）
 *  - 处理 Runtime.bindingCalled 事件 → 排队让 bridge 路由
 *  - 处理普通 CDP 响应 → 按 message id 路由给等待的 promise
 */

/** 跟 bridge.rs:17 一致：命令超时 5 秒 */
const CDP_COMMAND_TIMEOUT_MS = 5000
/** 跟 bridge.rs:16 一致：WebSocket 连接超时 5 秒 */
const CDP_CONNECT_TIMEOUT_MS = 5000

/** 单调递增的 message id（跟 bridge.rs 的 NEXT_MESSAGE_ID 等效） */
let nextMessageId = 100
export function nextCdpMessageId(): number {
  nextMessageId += 1
  return nextMessageId
}

export type CdpEventHandler = (params: Record<string, unknown>) => void | Promise<void>

export class CdpSession {
  private ws: WebSocket
  /** message id → resolve/reject pending */
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** 事件名（如 'Runtime.bindingCalled'） → handler 列表 */
  private eventHandlers = new Map<string, Set<CdpEventHandler>>()
  /** 标记是否关闭 */
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.on('message', (raw) => this.handleRaw(raw))
    this.ws.on('close', () => this.handleClose())
    this.ws.on('error', () => this.handleClose())
  }

  /**
   * 连接到 CDP WebSocket URL（5s 超时）
   */
  static async connect(wsUrl: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error(`timed out connecting CDP websocket after ${CDP_CONNECT_TIMEOUT_MS}ms`))
      }, CDP_CONNECT_TIMEOUT_MS)

      ws.once('open', () => {
        clearTimeout(timer)
        resolve(new CdpSession(ws))
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`failed to connect CDP websocket: ${err.message}`))
      })
    })
  }

  /**
   * 发 CDP 命令并等响应
   * 跟 bridge.rs:250 send_command 一致
   */
  async sendCommand(messageId: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      throw new Error(`CDP session closed; cannot send ${method}`)
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId)
        reject(new Error(`timed out waiting for CDP command ${method} id ${messageId} response after ${CDP_COMMAND_TIMEOUT_MS}ms`))
      }, CDP_COMMAND_TIMEOUT_MS)

      this.pending.set(messageId, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })

      const payload = JSON.stringify({ id: messageId, method, params })
      this.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(messageId)
          clearTimeout(timer)
          reject(new Error(`failed to send CDP command ${method} id ${messageId}: ${err.message}`))
        }
      })
    })
  }

  /**
   * 发 CDP 命令不等响应（fire-and-forget，用于 bridge 回调 renderer）
   */
  async sendCommandWithoutWait(messageId: number, method: string, params: Record<string, unknown>): Promise<void> {
    if (this.closed) return
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ id: messageId, method, params })
      this.ws.send(payload, (err) => {
        if (err) reject(new Error(`failed to send CDP command ${method}: ${err.message}`))
        else resolve()
      })
    })
  }

  /**
   * 注册事件 handler（如 'Runtime.bindingCalled'）
   * CDP 推送的 method 字段匹配 eventName 时触发
   */
  on(eventName: string, handler: CdpEventHandler): void {
    let set = this.eventHandlers.get(eventName)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(eventName, set)
    }
    set.add(handler)
  }

  /** 关闭 session */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // 忽略
    }
  }

  /** 是否已关闭 */
  isClosed(): boolean {
    return this.closed
  }

  private handleRaw(raw: RawData): void {
    let text: string
    if (typeof raw === 'string') text = raw
    else if (Buffer.isBuffer(raw)) text = raw.toString('utf8')
    else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8')
    else text = String(raw)

    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }

    // 响应：有 id 且有匹配的 pending
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`))
        } else {
          pending.resolve(msg)
        }
        return
      }
    }

    // 事件：有 method
    if (typeof msg.method === 'string') {
      const handlers = this.eventHandlers.get(msg.method)
      if (handlers) {
        for (const handler of handlers) {
          // 异步触发，不让 handler 阻塞主消息循环
          Promise.resolve()
            .then(() => handler(msg.params ?? {}))
            .catch((err) => console.error(`[cdp] event handler error for ${msg.method}:`, err))
        }
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    // 所有等待中的命令全部 reject
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`CDP websocket closed before response for id ${id}`))
    }
    this.pending.clear()
  }
}
