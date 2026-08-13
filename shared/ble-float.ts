/**
 * BLE 悬浮窗跨端协议契约（vibinguper ↔ S3LCDQSPI）—— 应用层共享类型与纯协议原语。
 *
 * 对应 docs/ble-float-protocol.md §2/§3/§4/§5。本文件不依赖 DOM 也不依赖 Node，
 * 因此同时被 tsconfig.node（electron/preload）与 tsconfig.web（renderer）编译。
 *
 * 角色约束：vibinguper = GATT Client（central）。projection 权威在主进程；
 * SessionData（WRITE）由主进程序列化/分片后下发；FocusCmd（NOTIFY）由设备回传。
 */

import type { AgentSessionStatus } from './agent-events'

// ───── §2 GATT 标识 ─────

/** 广播设备名，上位机据此扫描识别。 */
export const BLE_FLOAT_DEVICE_NAME = 'Vibing-Float'

export const BLE_FLOAT_SERVICE_UUID = '7b2a1c00-0000-1000-8000-00805f9b34fb'
export const BLE_FLOAT_SESSION_DATA_UUID =
  '7b2a1c01-0000-1000-8000-00805f9b34fb'
export const BLE_FLOAT_FOCUS_CMD_UUID =
  '7b2a1c02-0000-1000-8000-00805f9b34fb'

/**
 * 单次 GATT write 的字节数预算（= ATT MTU − 3）。
 *
 * Web Bluetooth 不暴露显式 requestMtu；Chromium/WinRT 在连接时与外设自动协商到
 * 二者支持的较大值（NimBLE 外设默认上限 512）。本默认值取保守的 254（要求协商
 * MTU ≥ 257，BLE 4.2+ 链路普遍满足）；联调确认协商到 512 后可上调到 509 以贴近
 * 契约 §2「MTU 512」意图。渲染进程在 connect 后经 report-state 把该值上报主进程，
 * 主进程据此分片，单点调整、无需改两端。
 */
export const BLE_FLOAT_DEFAULT_MAX_WRITE_SIZE = 254

// ───── §4 分片层 ─────

/**
 * 每个分片包头部 4 字节：[msg_id, total, index, plen]。
 * 包 = 头部 + payload；包总长 ≤ MTU−3。
 */
export const BLE_FRAGMENT_HEADER_SIZE = 4
/** 单条消息（完整 JSON）重组缓冲上限，超出设备端丢弃。上位机发送侧同等约束。 */
export const BLE_FLOAT_MSG_BUFFER_LIMIT = 4096

/**
 * 按 §4 把一条完整 JSON 字节流切成带头的分片包数组。
 *
 * `chunkBytes` 是每片 payload（不含头部）的最大字节数，由调用方按
 * `maxWriteSize − BLE_FRAGMENT_HEADER_SIZE` 推导。msg_id 为 uint8（mod 256）。
 */
export function fragmentSessionData(
  msgId: number,
  jsonBytes: Uint8Array,
  chunkBytes: number
): Uint8Array[] {
  const safeChunk = Math.max(1, Math.floor(chunkBytes))
  const total = Math.max(1, Math.ceil(jsonBytes.length / safeChunk))
  if (total > 255) {
    throw new Error(
      `ble-float: fragment total ${total} exceeds uint8 (reduce payload or raise maxWriteSize)`
    )
  }
  const packets: Uint8Array[] = []
  const idByte = msgId & 0xff
  for (let index = 0; index < total; index++) {
    const start = index * safeChunk
    const slice = jsonBytes.subarray(
      start,
      Math.min(start + safeChunk, jsonBytes.length)
    )
    const packet = new Uint8Array(BLE_FRAGMENT_HEADER_SIZE + slice.length)
    packet[0] = idByte
    packet[1] = total & 0xff
    packet[2] = index & 0xff
    packet[3] = slice.length & 0xff
    packet.set(slice, BLE_FRAGMENT_HEADER_SIZE)
    packets.push(packet)
  }
  return packets
}

/**
 * 解析 §3.2 FocusCmd（设备 NOTIFY 回传，单包，< 24 字节）。
 * 失败返回 null（设备端/总线噪声不应让上位机崩溃）。
 */
export function parseFocusCmd(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder().decode(bytes)
    const obj = JSON.parse(text) as unknown
    if (obj && typeof obj === 'object' && typeof (obj as { focus?: unknown }).focus === 'string') {
      return (obj as { focus: string }).focus
    }
    return null
  } catch {
    return null
  }
}

// ───── §3.1 / §5 应用层 JSON 线类型 ─────

export type BleStatusCode = 'w' | 'n' | 'd' | 'e' | 'i' | 'x'

/** §5：AgentSessionStatus → 单字符状态码。 */
export const BLE_STATUS_CODE: Record<AgentSessionStatus, BleStatusCode> = {
  working: 'w',
  'needs-you': 'n',
  done: 'd',
  error: 'e',
  idle: 'i',
  exited: 'x'
}

/** §3.1 SessionData items[] 元素（紧凑字段名）。 */
export interface BleSessionItemWire {
  id: string
  name: string
  s: BleStatusCode
  a: number
  tc: number
  la: number
}

/** §3.1 上位机→设备完整快照。 */
export interface BleSessionDataWire {
  seq: number
  now: number
  focus: string
  items: BleSessionItemWire[]
}

/** §3.2 设备→上位机聚焦命令。 */
export interface BleFocusCmdWire {
  focus: string
}

// ───── IPC 通道与 preload API 形状 ─────

/**
 * renderer → main（ipcMain.handle，请求-响应）。
 * 注意：与既有通道一致使用 `域:动作` 命名；BLE 通道归 ble-float 域。
 */
export const BleFloatInvokeChannel = {
  /** 渲染进程上报 GATT 连接状态（connected 后主进程开始下发分片）。 */
  ReportState: 'ble-float:report-state',
  /** 渲染进程收到设备 FocusCmd NOTIFY，回传焦点短 id。 */
  ReportFocus: 'ble-float:report-focus'
} as const

/** main → renderer（webContents.send，事件流）。 */
export const BleFloatEventChannel = {
  /** 主进程下发一个 §4 分片包，渲染进程写入 SessionData 特征。 */
  WriteSessionData: 'ble-float:write-session-data',
  /** 主进程要求断开（退出时）。渲染进程调 gatt.disconnect()。 */
  Disconnect: 'ble-float:disconnect'
} as const

/** 渲染进程上报的连接状态。 */
export interface BleFloatConnectionState {
  connected: boolean
  /** 协商后单次 write 字节预算（MTU−3）。主进程据此分片。 */
  maxWriteSize?: number
  /** 人类可读错误（连接失败/不支持），仅用于诊断日志。 */
  error?: string
}

/**
 * preload 暴露给渲染进程的 BLE 收窄 API。
 *
 * 语义：渲染进程是 Web Bluetooth 的实际持有者（GATT 句柄在其进程内）；
 * 主进程是协议权威（序列化/分片/焦点分发），通过该 API 与渲染进程交换
 * 「连接状态」与「焦点命令」，并下发分片包。
 */
export interface BleFloatApi {
  /** renderer → main：上报连接状态（连接成功 / 断开 / 错误）。 */
  reportState(state: BleFloatConnectionState): Promise<void>
  /** renderer → main：上报设备回传的焦点短 id。 */
  reportFocus(focusId: string): Promise<void>
  /** main → renderer：订阅 §4 分片包写入请求。返回取消订阅。 */
  onWrite(cb: (packet: Uint8Array) => void): () => void
  /** main → renderer：订阅主进程要求的断开。返回取消订阅。 */
  onDisconnect(cb: () => void): () => void
}
