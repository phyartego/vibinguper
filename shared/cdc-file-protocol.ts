/**
 * CDC 多通道二进制帧协议常量。
 * 与 components/vibing_usb/include/vb_cdc_proto.h 和 docs/cdc-file-protocol.md 同源。
 * 全部多字节字段小端。CRC32 为 IEEE 802.3（zlib）。
 */

export const VB_CDC_MAGIC_BYTES = new Uint8Array([0x56, 0x42, 0x46, 0x31]) // 'VBF1'
export const VB_CDC_MAGIC = 0x31464256
export const VB_CDC_PROTO_VERSION = 1
export const VB_CDC_HEADER_LEN = 22
export const VB_CDC_CRC_LEN = 4
export const VB_CDC_MAX_PAYLOAD = 1024
export const VB_CDC_MAX_FRAME =
  VB_CDC_HEADER_LEN + VB_CDC_MAX_PAYLOAD + VB_CDC_CRC_LEN

export const VB_CDC_CH = {
  CONSOLE: 0x01,
  RPC: 0x02,
  FILE: 0x03,
  EVENT: 0x04
} as const

export const VB_CDC_F = {
  ACK: 0x0001,
  NACK: 0x0002,
  MORE: 0x0004,
  CANCEL: 0x0008,
  EVENT: 0x0010
} as const

export const VB_CDC_CMD = {
  DEVICE_INFO: 0x0001,
  CAPACITY: 0x0002,
  PLUGIN_LIST: 0x0010,
  FILE_LIST: 0x0011,
  FILE_STAT: 0x0012,
  FILE_READ_BEGIN: 0x0020,
  FILE_READ_CHUNK: 0x0021,
  FILE_WRITE_BEGIN: 0x0030,
  FILE_WRITE_CHUNK: 0x0031,
  FILE_WRITE_COMMIT: 0x0032,
  TXN_BEGIN: 0x0033,
  TXN_STATUS: 0x0034,
  MKDIR: 0x0040,
  RENAME: 0x0041,
  DELETE: 0x0042,
  BUNDLE_VALIDATE: 0x0050,
  BUNDLE_ACTIVATE: 0x0051,
  PLUGIN_START: 0x0060,
  PLUGIN_STOP: 0x0061,
  PLUGIN_RESTART: 0x0062,
  ROLLBACK: 0x0063,
  TOUCH_ROUTE_GET: 0x0070,
  TOUCH_ROUTE_SET: 0x0071,
  LOG_SUBSCRIBE: 0x0080,
  CANCEL: 0x00ff
} as const

export const VB_CDC_EVT = {
  LOG: 0x0200,
  TXN_PROGRESS: 0x0201,
  TXN_RESULT: 0x0202,
  PLUGIN_STATE: 0x0203
} as const

export const VB_CDC_ERR = {
  OK: 0x0000,
  BAD_MAGIC: 0x0001,
  BAD_VERSION: 0x0002,
  BAD_CRC: 0x0003,
  BAD_LENGTH: 0x0004,
  TRUNCATED: 0x0005,
  TOO_LONG: 0x0006,
  DUP_SEQ: 0x0007,
  OUT_OF_ORDER: 0x0008,
  UNKNOWN_CMD: 0x0009,
  UNAUTHORIZED: 0x000a,
  NOT_FOUND: 0x000b,
  EXISTS: 0x000c,
  PATH_INVALID: 0x000d,
  PATH_ESCAPE: 0x000e,
  QUOTA: 0x000f,
  NO_SPACE: 0x0010,
  HASH_MISMATCH: 0x0011,
  SYNTAX: 0x0012,
  MISSING_MAIN: 0x0013,
  EMPTY_MAIN: 0x0014,
  CONFLICT_GEN: 0x0015,
  BUSY: 0x0016,
  CANCELLED: 0x0017,
  TIMEOUT: 0x0018,
  IO: 0x0019,
  UNSUPPORTED: 0x001a,
  NATIVE_PLUGIN: 0x001b,
  ROLLBACK_FAILED: 0x001c,
  VM_START_FAILED: 0x001d,
  ENCODING: 0x001e,
  OVERFLOW: 0x001f,
  INVALID_STATE: 0x0020,
  READONLY: 0x0021,
  SYSTEM_HIDDEN: 0x0022,
  BINARY_AS_TEXT: 0x0023,
  NOT_READY: 0x0024
} as const

export const VB_PLUGIN_LIMITS = {
  ID_MAX: 15,
  REL_PATH_MAX: 96,
  NAME_MAX: 64,
  FILES_MAX: 64,
  MAIN_PY_MAX: 256 * 1024,
  FILE_MAX: 512 * 1024,
  BUNDLE_MAX: 768 * 1024,
  DATA_MAX: 32 * 1024,
  VERSIONS_KEPT: 2
} as const

export const VB_USB_VID = 0x303a
export const VB_USB_PID = 0x1001

export type VbCdcChannel = (typeof VB_CDC_CH)[keyof typeof VB_CDC_CH]
export type VbCdcCmd = (typeof VB_CDC_CMD)[keyof typeof VB_CDC_CMD]
export type VbCdcErr = (typeof VB_CDC_ERR)[keyof typeof VB_CDC_ERR]

export interface VbCdcFrame {
  version: number
  channel: number
  command: number
  flags: number
  txnId: number
  seq: number
  payload: Uint8Array
}

export type TouchRoute = 'local_ui' | 'usb_touchpad'

export type PluginKind = 'native' | 'script'
