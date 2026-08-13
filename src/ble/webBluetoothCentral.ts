/**
 * WebBluetoothBleCentral（renderer）—— GATT Client 实际持有者。
 *
 * Web Bluetooth 只能在 renderer（navigator.bluetooth）运行；主进程是协议权威，
 * 通过 window.bleFloatApi 与本类交换「连接状态 / 分片包 / 焦点命令」。本类只做
 * 透明的 GATT 字节管道：连接、发现 service/char、订阅 FocusCmd NOTIFY、把主进程
 * 下发的 §4 分片包写入 SessionData 特征。协议逻辑（序列化/分片/排序）全在主进程。
 *
 * 生命周期：用户点击「连接」按钮（必须 user gesture）→ connect() → requestDevice
 * 选择器 → 连接 → 发现 → startNotifications → reportState(connected) → 主进程开始
 * 经 onWrite 下发分片。断开（用户/退出）→ disconnect()。
 */

import {
  BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE,
  BLE_FLOAT_DEVICE_NAME,
  BLE_FLOAT_FOCUS_CMD_UUID,
  BLE_FLOAT_SERVICE_UUID,
  BLE_FLOAT_SESSION_DATA_UUID,
  parseFocusCmd,
  type BleFloatApi
} from '../../shared/ble-float'

export type BleCentralState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'disconnected' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

export class WebBluetoothBleCentral {
  private device: BluetoothDevice | null = null
  private sessionChar: BluetoothRemoteGATTCharacteristic | null = null
  private focusChar: BluetoothRemoteGATTCharacteristic | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private unsubWrite: (() => void) | null = null
  private unsubDisconnect: (() => void) | null = null
  private focusHandler:
    | ((event: Event) => void)
    | null = null
  private disconnectHandler: (() => void) | null = null
  private maxWriteSize = BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE

  constructor(
    private readonly api: BleFloatApi,
    private readonly onStateChange: (state: BleCentralState) => void
  ) {}

  /** 浏览器/Electron 是否启用 Web Bluetooth。 */
  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth
  }

  /**
   * 由用户手势（按钮 onClick）触发。完成后经 reportState 上报主进程；
   * 主进程在 connected 时立即下发一次完整快照。所有状态转移（含设备主动断开）
   * 经 onStateChange 回调通知持有者，避免 UI 指示灯与真实连接不同步。
   */
  async connect(): Promise<void> {
    console.log('[ble-float] connect() called, supported =', this.supported)
    if (!this.supported) {
      this.onStateChange({ status: 'unsupported' })
      await this.safeReport({ connected: false, error: 'unsupported' })
      return
    }
    // Web Bluetooth 不会自动开启系统蓝牙：adapter 关闭时 requestDevice 会静默 reject，
    // 这里先用 getAvailability 探测，给出明确的“请先开蓝牙”提示。
    try {
      const available = await navigator.bluetooth.getAvailability()
      console.log('[ble-float] bluetooth availability =', available)
      if (!available) {
        const msg = '蓝牙未开启，请先打开电脑蓝牙'
        this.onStateChange({ status: 'error', message: msg })
        await this.safeReport({ connected: false, error: msg })
        return
      }
    } catch (e) {
      console.log('[ble-float] getAvailability threw:', describeError(e))
    }
    if (this.device) {
      this.onStateChange({ status: 'connected' })
      return
    }

    this.onStateChange({ status: 'connecting' })
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ name: BLE_FLOAT_DEVICE_NAME }],
        optionalServices: [BLE_FLOAT_SERVICE_UUID]
      })
    } catch (error) {
      const message = describeError(error)
      console.log('[ble-float] requestDevice rejected:', message)
      // 用户主动取消：静默回 idle
      if (/cancelled|canceled/i.test(message)) {
        this.onStateChange({ status: 'idle' })
        return
      }
      // 未找到设备 / 扫描超时 / 蓝牙不可用：给明确原因，不再静默回 idle
      const userMsg = /not found|chooser|timed ?out|not available|no adapter|search/i.test(message)
        ? '未找到 Vibing-Float（ESP32 是否已插上并烧录固件？）'
        : message
      this.onStateChange({ status: 'error', message: userMsg })
      await this.safeReport({ connected: false, error: userMsg })
      return
    }

    this.disconnectHandler = (): void => {
      this.teardown()
      this.onStateChange({ status: 'disconnected' })
      void this.safeReport({ connected: false })
    }
    this.device.addEventListener('gattserverdisconnected', this.disconnectHandler)

    try {
      const gatt = this.device.gatt
      if (!gatt) {
        throw new Error('device exposes no GATT server')
      }
      const server = await gatt.connect()
      const service = await server.getPrimaryService(BLE_FLOAT_SERVICE_UUID)
      this.sessionChar = await service.getCharacteristic(
        BLE_FLOAT_SESSION_DATA_UUID
      )
      this.focusChar = await service.getCharacteristic(BLE_FLOAT_FOCUS_CMD_UUID)

      this.focusHandler = (event: Event): void => {
        const target = event.target as BluetoothRemoteGATTCharacteristic | null
        const value = target?.value
        if (!value) return
        const bytes = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength
        )
        const focus = parseFocusCmd(bytes)
        if (focus) void this.api.reportFocus(focus)
      }
      this.focusChar.addEventListener(
        'characteristicvaluechanged',
        this.focusHandler
      )
      await this.focusChar.startNotifications()

      // 订阅主进程→renderer 的分片写入请求与断开请求。
      this.unsubWrite = this.api.onWrite((packet) => {
        this.enqueueWrite(packet)
      })
      this.unsubDisconnect = this.api.onDisconnect(() => {
        this.teardown()
        this.onStateChange({ status: 'disconnected' })
      })

      await this.safeReport({ connected: true, maxWriteSize: this.maxWriteSize })
      this.onStateChange({ status: 'connected' })
    } catch (error) {
      const message = describeError(error)
      this.teardown()
      this.onStateChange({ status: 'error', message })
      await this.safeReport({ connected: false, error: message })
    }
  }

  /** 主动断开（UI 按钮 / 组件卸载）。 */
  disconnect(): void {
    if (this.device) {
      void this.safeReport({ connected: false })
    }
    this.teardown()
  }

  // ── 内部 ──

  /**
   * 串行化 GATT 写，保证分片包按 §4 index 顺序到达设备。
   * 用 write-without-response（契约 §4 默认），失败仅告警不中断。
   */
  private enqueueWrite(packet: Uint8Array): void {
    const characteristic = this.sessionChar
    if (!characteristic) return
    this.writeChain = this.writeChain.then(async () => {
      try {
        // TS 5.7+ 起 Uint8Array 是泛型 Uint8Array<ArrayBufferLike>，与 Web Bluetooth 的
        // BufferSource(ArrayBufferView<ArrayBuffer>) 不兼容；复制成 ArrayBuffer-backed 即可。
        await characteristic.writeValueWithoutResponse(new Uint8Array(packet))
      } catch (error) {
        console.warn('[ble-float] write failed:', describeError(error))
      }
    })
  }

  private teardown(): void {
    if (this.focusChar && this.focusHandler) {
      try {
        this.focusChar.removeEventListener(
          'characteristicvaluechanged',
          this.focusHandler
        )
      } catch {
        /* 已经断开时 remove 可能抛错，忽略 */
      }
    }
    this.focusHandler = null
    this.focusChar = null
    this.sessionChar = null
    this.unsubWrite?.()
    this.unsubWrite = null
    this.unsubDisconnect?.()
    this.unsubDisconnect = null
    const device = this.device
    this.device = null
    if (device) {
      try {
        device.removeEventListener(
          'gattserverdisconnected',
          this.disconnectHandler as EventListener
        )
      } catch {
        /* ignore */
      }
      this.disconnectHandler = null
      try {
        device.gatt?.disconnect()
      } catch {
        /* ignore */
      }
    }
    // 丢弃尚未发出的排队写。
    this.writeChain = Promise.resolve()
  }

  private async safeReport(state: {
    connected: boolean
    maxWriteSize?: number
    error?: string
  }): Promise<void> {
    try {
      await this.api.reportState(state)
    } catch {
      /* 主进程未注册 handler（卸载竞态）时忽略 */
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 256)
  return String(error).slice(0, 256)
}
