/**
 * SessionBleBroadcaster（主进程）—— BLE 悬浮窗会话推送的生命周期所有者。
 *
 * 仿 FloatingWindowController 的生命周期形态：在 main.ts 构造、before-quit 释放。
 * 职责：订阅 AgentSessionProjection 变化 → 序列化为 §3.1 快照 → §4 分片 → 经
 * BleTransport 下发；接收设备 FocusCmd → 复用既有 focus-session 聚焦终端。
 *
 * projection 权威仍在 AgentSessionRuntime（main）；本模块只读 listActive() 快照。
 * Transport 是可替换的 IO 边界（当前实现 IpcBleTransport 经 renderer Web Bluetooth；
 * 若将来切 @stoprocent/noble 在 main 进程，只需换 Transport 实现，本类不动）。
 */

import type { AgentSessionProjection, AgentSessionStatus } from '../../shared/agent-events'
import {
  BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE,
  BLE_FLOAT_MSG_BUFFER_LIMIT,
  BLE_FRAGMENT_HEADER_SIZE,
  fragmentSessionData
} from '../../shared/ble-float'
import {
  buildSessionData,
  type ShortIdMapEntry
} from './protocol'

/** 投影变化后合并突发更新的尾沿去抖窗口（ms）。 */
const PUSH_DEBOUNCE_MS = 120

/**
 * BLE central 的 IO 边界。Broadcaster 只依赖这组方法，
 * 具体实现（IPC→Web Bluetooth 或 main 内 noble）可替换。
 */
export interface BleTransport {
  /** GATT 是否已连。未连时 Broadcaster 跳过下发，避免无意义分片。 */
  isConnected(): boolean
  /** 写入一个 §4 分片包（设备 SessionData WRITE 特征）。 */
  write(packet: Uint8Array): void
}

export interface SessionBleBroadcasterDeps {
  /** 取当前活动会话投影快照（复用 AgentSessionRuntime.listActive()）。 */
  listActive(): AgentSessionProjection[]
  /** 底层 GATT 传输。 */
  transport: BleTransport
  /**
   * 聚焦某 sessionId 的终端。复用既有 FloatingWindowController.focusSession：
   * 恢复并置顶主窗口 + 向 renderer 发 app:focus-session。
   */
  focusSession(sessionId: string): boolean
}

export class SessionBleBroadcaster {
  private readonly shortIdMap = new Map<string, ShortIdMapEntry>()
  private previousStatus = new Map<string, AgentSessionStatus>()
  private seq = 0
  private msgId = 0
  private chunkBytes = BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE - BLE_FRAGMENT_HEADER_SIZE
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly deps: SessionBleBroadcasterDeps) {}

  /**
   * AgentSessionRuntime 广播 projection 时（main.ts 的 broadcast 回调）调用本方法。
   * 不立即推送：合并 120ms 突发后取最新快照一次性下发。
   */
  notifyProjectionChanged(): void {
    if (this.disposed) return
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.push()
    }, PUSH_DEBOUNCE_MS)
  }

  /** 渲染进程上报已连接时调用：立即下发一次当前快照，让设备首屏就位。 */
  onConnected(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    this.push()
  }

  /** 渲染进程协商出新的单包预算（MTU−3）时调整分片粒度。 */
  setMaxChunkBytes(maxWriteSize: number): void {
    if (!Number.isFinite(maxWriteSize) || maxWriteSize < BLE_FRAGMENT_HEADER_SIZE + 1) return
    this.chunkBytes = Math.floor(maxWriteSize - BLE_FRAGMENT_HEADER_SIZE)
  }

  /**
   * 设备 FocusCmd 回传的短 id → 复用 focus-session 聚焦对应终端。
   * 短 id 查不到（过期/伪造）时静默忽略。
   */
  handleFocus(shortId: string): void {
    if (this.disposed) return
    const entry = this.shortIdMap.get(shortId)
    if (!entry) return
    this.deps.focusSession(entry.sessionId)
  }

  dispose(): void {
    this.disposed = true
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
  }

  private push(): void {
    if (this.disposed) return
    if (!this.deps.transport.isConnected()) return

    const projections = this.deps.listActive()
    this.seq = (this.seq + 1) & 0xffff
    const data = buildSessionData(
      projections,
      this.seq,
      this.previousStatus,
      this.shortIdMap
    )
    // 更新「上一轮状态」基线；已退出并从 listActive 移除的 session 自然被丢弃。
    const nextStatus = new Map<string, AgentSessionStatus>()
    for (const projection of projections) {
      nextStatus.set(projection.sessionId, projection.status)
    }
    this.previousStatus = nextStatus

    // §3.1 紧凑要求：minify。
    const json = JSON.stringify(data)
    const jsonBytes = new TextEncoder().encode(json)
    if (jsonBytes.length > BLE_FLOAT_MSG_BUFFER_LIMIT) {
      console.warn(
        `[ble-float] session data ${jsonBytes.length}B exceeds ${BLE_FLOAT_MSG_BUFFER_LIMIT}B limit; skipped`
      )
      return
    }

    this.msgId = (this.msgId + 1) & 0xff
    const packets = fragmentSessionData(this.msgId, jsonBytes, this.chunkBytes)
    for (const packet of packets) {
      this.deps.transport.write(packet)
    }
  }
}
