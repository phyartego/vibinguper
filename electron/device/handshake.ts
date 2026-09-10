import { VB_CDC_PROTO_VERSION } from '../../shared/cdc-file-protocol'
import {
  DEVICE_GESTURE_ACTIONS,
  DEVICE_THEMES,
  type DeviceCapacity,
  type DeviceGestureAction,
  type DeviceGestureMap,
  type DeviceThemeStatus
} from '../../shared/device-ipc'

export type HandshakeReason = 'proto' | 'serial' | 'cap'

export class HandshakeError extends Error {
  readonly reason: HandshakeReason

  constructor(reason: HandshakeReason, message: string) {
    super(message)
    this.name = 'HandshakeError'
    this.reason = reason
  }
}

export type VerifiedDeviceInfo = {
  serial: string
  proto: number
  fwVersion?: string
  chip?: string
  hid?: unknown
  touchRoute?: 'local_ui' | 'usb_touchpad'
  deviceTheme?: DeviceThemeStatus
  gestureMap?: DeviceGestureMap
  capacity?: DeviceCapacity
  capabilities: string[]
  nativePlugins: string[]
  scriptPlugins: string[]
}

export function normalizeSerial(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
}

/**
 * Firmware contract: the USB iSerial is `VB` + 12 hex chars (MAC address).
 * Only a host-side serial with this exact shape may be compared against
 * DEVICE_INFO.serial. Windows composite CDC reports the interface instance
 * (`USB\...&MI_00\8&5D5D7E&0&0000` → serialNumber `8&5D5D7E&0&0000`) and
 * Linux/macOS may report plain `COMx`/device paths instead; neither is the
 * device iSerial, so they must never trigger a serial mismatch.
 */
const VB_SERIAL_CONTRACT = /^VB[0-9A-F]{12}$/

export function looksLikeFirmwareSerial(value: string): boolean {
  return VB_SERIAL_CONTRACT.test(normalizeSerial(value))
}

export function parseCapabilities(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).toLowerCase()).filter(Boolean)
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true || enabled === 1)
      .map(([key]) => key.toLowerCase())
  }
  return []
}

export function hasFilePluginCapabilities(caps: readonly string[]): boolean {
  const set = new Set(caps.map((c) => c.toLowerCase()))
  const file =
    set.has('file') ||
    set.has('file_rpc') ||
    set.has('cdc_file') ||
    set.has('cdc_rpc') ||
    set.has('plugin_fs')
  const plugin =
    set.has('plugin') ||
    set.has('plugin_rpc') ||
    set.has('cdc_plugin') ||
    set.has('plugin_fs') ||
    set.has('txn')
  return file && plugin
}

function asCapacity(raw: unknown): DeviceCapacity | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.total !== 'number' || typeof o.used !== 'number' || typeof o.free !== 'number') {
    return undefined
  }
  return { total: o.total, used: o.used, free: o.free }
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((item) => String(item)).filter(Boolean) : []
}

export function parseDeviceTheme(raw: unknown): DeviceThemeStatus | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return value === 'custom' || (DEVICE_THEMES as readonly string[]).includes(value)
    ? (value as DeviceThemeStatus)
    : undefined
}

export function parseGestureAction(raw: unknown): DeviceGestureAction | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return (DEVICE_GESTURE_ACTIONS as readonly string[]).includes(value)
    ? (value as DeviceGestureAction)
    : undefined
}

/**
 * Parse the optional DEVICE_INFO gesture map without trusting arbitrary JSON.
 * A malformed side falls back to `none`; a map with no recognized side is
 * treated as unavailable so callers can distinguish old firmware.
 */
export function parseGestureMap(raw: unknown): DeviceGestureMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const left = parseGestureAction(value.left)
  const right = parseGestureAction(value.right)
  if (left === undefined && right === undefined) return undefined
  return { left: left ?? 'none', right: right ?? 'none' }
}

export function verifyHandshake(
  usbSerial: string,
  payload: Record<string, unknown>
): VerifiedDeviceInfo {
  const proto = Number(payload.proto ?? payload.protocol)
  if (proto !== VB_CDC_PROTO_VERSION) {
    throw new HandshakeError(
      'proto',
      `incompatible protocol: expected ${VB_CDC_PROTO_VERSION}, got ${String(payload.proto ?? payload.protocol)}`
    )
  }
  const serialRaw = typeof payload.serial === 'string' ? payload.serial.trim() : ''
  if (!serialRaw) {
    throw new HandshakeError('serial', 'missing serial in DEVICE_INFO')
  }
  // Enforce the iSerial contract only when the host side itself looks like
  // `VB` + MAC. Anything else (Windows MI_00 instance, COM path, test rigs)
  // cannot be trusted as the device serial, so the DEVICE_INFO value wins.
  if (
    usbSerial &&
    looksLikeFirmwareSerial(usbSerial) &&
    normalizeSerial(usbSerial) !== normalizeSerial(serialRaw)
  ) {
    throw new HandshakeError(
      'serial',
      `serial mismatch: usb=${usbSerial} device=${serialRaw}`
    )
  }
  const capabilities = parseCapabilities(payload.capabilities ?? payload.caps)
  if (!hasFilePluginCapabilities(capabilities)) {
    throw new HandshakeError('cap', 'missing file/plugin capability')
  }
  const touch =
    payload.touch_route === 'usb_touchpad' || payload.touchRoute === 'usb_touchpad'
      ? 'usb_touchpad'
      : payload.touch_route === 'local_ui' || payload.touchRoute === 'local_ui'
        ? 'local_ui'
        : undefined
  const deviceTheme = parseDeviceTheme(payload.device_theme ?? payload.deviceTheme)
  const gestureMap = parseGestureMap(payload.gesture_map ?? payload.gestureMap)
  const fwVersion =
    typeof payload.fw_version === 'string'
      ? payload.fw_version
      : typeof payload.fwVersion === 'string'
        ? payload.fwVersion
        : undefined
  return {
    serial: serialRaw,
    proto,
    fwVersion,
    chip: typeof payload.chip === 'string' ? payload.chip : undefined,
    hid: payload.hid,
    touchRoute: touch,
    deviceTheme,
    gestureMap,
    capacity: asCapacity(payload.capacity),
    capabilities,
    nativePlugins: asStringArray(payload.native_plugins ?? payload.nativePlugins),
    scriptPlugins: asStringArray(payload.script_plugins ?? payload.scriptPlugins)
  }
}
