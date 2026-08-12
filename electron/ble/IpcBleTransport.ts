/**
 * IpcBleTransport（主进程）—— BleTransport 的 IPC 实现。
 *
 * Web Bluetooth 只能运行在 renderer（navigator.bluetooth）。本类把主进程的
 * 「写一个分片包」翻译成向主窗口 renderer 的 webContents.send；把 renderer
 * 上报的「连接状态 / FocusCmd」翻译成对 Broadcaster 的回调。所有协议逻辑
 * （序列化/分片/排序/焦点）仍在主进程，renderer 只做透明的 GATT 字节管道。
 *
 * 生命周期：main.ts 构造本类 → 构造 Broadcaster → 调 wire(broadcaster) 注册
 * ipcMain.handle → before-quit 调 dispose() 注销 handler 并通知 renderer 断开。
 */

import { BrowserWindow, ipcMain } from 'electron'
import {
  BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE,
  BLE_FRAGMENT_HEADER_SIZE,
  BleFloatEventChannel,
  BleFloatInvokeChannel,
  type BleFloatConnectionState
} from '../../shared/ble-float'
import type { SessionBleBroadcaster } from './SessionBleBroadcaster'

export interface IpcBleTransportDeps {
  /** 取承载 Web Bluetooth 的主窗口（central 运行在主窗口 renderer）。 */
  getMainWindow: () => BrowserWindow | null
}

export class IpcBleTransport {
  private connected = false
  private maxWriteSize = BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE
  private broadcaster: SessionBleBroadcaster | null = null

  constructor(private readonly deps: IpcBleTransportDeps) {}

  /**
   * 注册 IPC handler。必须传 Broadcaster 实例（main.ts 中 Broadcaster 先于本调用构造，
   * Broadcaster 反过来持有本 transport 引用，构成一次性 wire）。
   */
  wire(broadcaster: SessionBleBroadcaster): void {
    this.broadcaster = broadcaster
    ipcMain.handle(BleFloatInvokeChannel.ReportState, (_event, state: unknown) => {
      this.handleReportState(state)
      return undefined
    })
    ipcMain.handle(BleFloatInvokeChannel.ReportFocus, (_event, payload: unknown) => {
      const id = extractFocusId(payload)
      if (id) this.broadcaster?.handleFocus(id)
      return undefined
    })
  }

  // ── BleTransport 实现 ──

  isConnected(): boolean {
    return this.connected
  }

  write(packet: Uint8Array): void {
    if (!this.connected) return
    const win = this.deps.getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(BleFloatEventChannel.WriteSessionData, packet)
  }

  // ── 生命周期 ──

  /** 请求 renderer 断开 GATT（应用退出时）。 */
  requestDisconnect(): void {
    const win = this.deps.getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(BleFloatEventChannel.Disconnect)
  }

  dispose(): void {
    this.connected = false
    this.requestDisconnect()
    ipcMain.removeHandler(BleFloatInvokeChannel.ReportState)
    ipcMain.removeHandler(BleFloatInvokeChannel.ReportFocus)
  }

  // ── 内部 ──

  private handleReportState(state: unknown): void {
    const parsed = parseConnectionState(state)
    if (!parsed) return
    const wasConnected = this.connected
    this.connected = parsed.connected
    if (parsed.maxWriteSize !== undefined) {
      this.maxWriteSize = parsed.maxWriteSize
      this.broadcaster?.setMaxChunkBytes(this.maxWriteSize)
    }
    if (!wasConnected && this.connected) {
      this.broadcaster?.onConnected()
    }
    if (!this.connected && parsed.error) {
      console.warn('[ble-float] renderer reported error:', parsed.error)
    }
  }
}

function extractFocusId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = (payload as { focus?: unknown }).focus
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null
}

function parseConnectionState(
  state: unknown
): (BleFloatConnectionState & { maxWriteSize?: number }) | null {
  if (!state || typeof state !== 'object') return null
  const raw = state as {
    connected?: unknown
    maxWriteSize?: unknown
    error?: unknown
  }
  if (typeof raw.connected !== 'boolean') return null
  const result: BleFloatConnectionState & { maxWriteSize?: number } = {
    connected: raw.connected
  }
  if (
    typeof raw.maxWriteSize === 'number' &&
    Number.isFinite(raw.maxWriteSize) &&
    raw.maxWriteSize >= BLE_FRAGMENT_HEADER_SIZE + 1
  ) {
    result.maxWriteSize = Math.min(512, Math.floor(raw.maxWriteSize))
  }
  if (typeof raw.error === 'string' && raw.error.length > 0) {
    result.error = raw.error.slice(0, 256)
  }
  return result
}
