import {
  VB_CDC_CRC_LEN,
  VB_CDC_HEADER_LEN,
  VB_CDC_MAGIC_BYTES,
  VB_CDC_MAX_PAYLOAD,
  VB_CDC_PROTO_VERSION,
  type VbCdcFrame
} from './cdc-file-protocol'

export function crc32Ieee(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u32le(n: number): Uint8Array {
  const o = new Uint8Array(4)
  o[0] = n & 0xff
  o[1] = (n >>> 8) & 0xff
  o[2] = (n >>> 16) & 0xff
  o[3] = (n >>> 24) & 0xff
  return o
}

function readU32le(b: Uint8Array, off: number): number {
  return (
    (b[off] ?? 0) |
    ((b[off + 1] ?? 0) << 8) |
    ((b[off + 2] ?? 0) << 16) |
    ((b[off + 3] ?? 0) << 24)
  ) >>> 0
}

export function encodeFrame(frame: VbCdcFrame): Uint8Array {
  if (frame.payload.length > VB_CDC_MAX_PAYLOAD) {
    throw new Error('payload too long')
  }
  const out = new Uint8Array(
    VB_CDC_HEADER_LEN + frame.payload.length + VB_CDC_CRC_LEN
  )
  out.set(VB_CDC_MAGIC_BYTES, 0)
  out[4] = frame.version || VB_CDC_PROTO_VERSION
  out[5] = frame.channel
  out[6] = frame.command & 0xff
  out[7] = (frame.command >>> 8) & 0xff
  out[8] = frame.flags & 0xff
  out[9] = (frame.flags >>> 8) & 0xff
  out.set(u32le(frame.txnId), 10)
  out.set(u32le(frame.seq), 14)
  out.set(u32le(frame.payload.length), 18)
  out.set(frame.payload, VB_CDC_HEADER_LEN)
  const crc = crc32Ieee(out.subarray(0, VB_CDC_HEADER_LEN + frame.payload.length))
  out.set(u32le(crc), VB_CDC_HEADER_LEN + frame.payload.length)
  return out
}

export function decodeFrame(buf: Uint8Array): VbCdcFrame {
  if (buf.length < VB_CDC_HEADER_LEN + VB_CDC_CRC_LEN) {
    throw new Error('truncated')
  }
  if (
    buf[0] !== VB_CDC_MAGIC_BYTES[0] ||
    buf[1] !== VB_CDC_MAGIC_BYTES[1] ||
    buf[2] !== VB_CDC_MAGIC_BYTES[2] ||
    buf[3] !== VB_CDC_MAGIC_BYTES[3]
  ) {
    throw new Error('bad magic')
  }
  if (buf[4] !== VB_CDC_PROTO_VERSION) {
    throw new Error('bad version')
  }
  const payloadLen = readU32le(buf, 18)
  if (payloadLen > VB_CDC_MAX_PAYLOAD) {
    throw new Error('too long')
  }
  const total = VB_CDC_HEADER_LEN + payloadLen + VB_CDC_CRC_LEN
  if (buf.length < total) {
    throw new Error('truncated')
  }
  const got = readU32le(buf, VB_CDC_HEADER_LEN + payloadLen)
  const expect = crc32Ieee(buf.subarray(0, VB_CDC_HEADER_LEN + payloadLen))
  if (got !== expect) {
    throw new Error('bad crc')
  }
  return {
    version: buf[4] ?? 0,
    channel: buf[5] ?? 0,
    command: (buf[6] ?? 0) | ((buf[7] ?? 0) << 8),
    flags: (buf[8] ?? 0) | ((buf[9] ?? 0) << 8),
    txnId: readU32le(buf, 10),
    seq: readU32le(buf, 14),
    payload: buf.subarray(VB_CDC_HEADER_LEN, VB_CDC_HEADER_LEN + payloadLen)
  }
}

export class CdcParser {
  private buf = new Uint8Array(0)

  feed(chunk: Uint8Array): VbCdcFrame[] {
    const frames: VbCdcFrame[] = []
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged
    while (this.buf.length >= 4) {
      if (
        this.buf[0] !== VB_CDC_MAGIC_BYTES[0] ||
        this.buf[1] !== VB_CDC_MAGIC_BYTES[1] ||
        this.buf[2] !== VB_CDC_MAGIC_BYTES[2] ||
        this.buf[3] !== VB_CDC_MAGIC_BYTES[3]
      ) {
        this.buf = this.buf.subarray(1)
        continue
      }
      if (this.buf.length < VB_CDC_HEADER_LEN) {
        break
      }
      const payloadLen = readU32le(this.buf, 18)
      if (payloadLen > VB_CDC_MAX_PAYLOAD) {
        this.buf = this.buf.subarray(1)
        continue
      }
      const total = VB_CDC_HEADER_LEN + payloadLen + VB_CDC_CRC_LEN
      if (this.buf.length < total) {
        break
      }
      frames.push(decodeFrame(this.buf.subarray(0, total)))
      this.buf = this.buf.subarray(total)
    }
    return frames
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
