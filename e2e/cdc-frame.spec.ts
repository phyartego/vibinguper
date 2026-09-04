import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  VB_CDC_CMD,
  VB_CDC_CH,
  VB_CDC_F,
  VB_CDC_MAX_PAYLOAD
} from '../shared/cdc-file-protocol'
import {
  CdcParser,
  crc32Ieee,
  decodeFrame,
  encodeFrame,
  hexToBytes
} from '../shared/cdc-frame'

const vectors = JSON.parse(
  readFileSync(join(process.cwd(), '../docs/cdc-file-protocol-vectors.json'), 'utf8')
) as {
  empty_device_info_req: string
  ack_ok_json: string
  crc_error_frame: string
  truncated_frame: string
  too_long_payload_len_header: string
  sha256_empty: string
  sha256_hello: string
  crc32_empty_req_body: string
  bundle_example: { bundle_sha256: string; generation: number }
}

test('empty DEVICE_INFO vector roundtrip', () => {
  const raw = hexToBytes(vectors.empty_device_info_req)
  const frame = decodeFrame(raw)
  expect(frame.channel).toBe(VB_CDC_CH.RPC)
  expect(frame.command).toBe(VB_CDC_CMD.DEVICE_INFO)
  expect(frame.txnId).toBe(1)
  const encoded = encodeFrame({
    version: 1,
    channel: VB_CDC_CH.RPC,
    command: VB_CDC_CMD.DEVICE_INFO,
    flags: 0,
    txnId: 1,
    seq: 0,
    payload: new Uint8Array()
  })
  expect(Buffer.from(encoded).toString('hex')).toBe(vectors.empty_device_info_req)
})

test('ack json vector', () => {
  const frame = decodeFrame(hexToBytes(vectors.ack_ok_json))
  expect(frame.flags).toBe(VB_CDC_F.ACK)
  expect(new TextDecoder().decode(frame.payload)).toBe('{"ok":true}')
})

test('crc error', () => {
  expect(() => decodeFrame(hexToBytes(vectors.crc_error_frame))).toThrow(/crc/)
})

test('truncated', () => {
  expect(() => decodeFrame(hexToBytes(vectors.truncated_frame))).toThrow(/truncated/)
})

test('bad magic', () => {
  const raw = hexToBytes(vectors.empty_device_info_req)
  raw[0] = 0x00
  expect(() => decodeFrame(raw)).toThrow(/magic/)
})

test('encode rejects payload over max', () => {
  expect(() =>
    encodeFrame({
      version: 1,
      channel: VB_CDC_CH.RPC,
      command: VB_CDC_CMD.DEVICE_INFO,
      flags: 0,
      txnId: 1,
      seq: 0,
      payload: new Uint8Array(VB_CDC_MAX_PAYLOAD + 1)
    })
  ).toThrow(/too long/)
})

test('parser drops too-long payload_len then resyncs', () => {
  const parser = new CdcParser()
  const junk = hexToBytes(vectors.too_long_payload_len_header)
  expect(parser.feed(junk)).toHaveLength(0)
  const valid = hexToBytes(vectors.empty_device_info_req)
  expect(parser.feed(valid)).toHaveLength(1)
})

test('sha256 vectors', () => {
  expect(createHash('sha256').update('').digest('hex')).toBe(vectors.sha256_empty)
  expect(createHash('sha256').update('hello').digest('hex')).toBe(vectors.sha256_hello)
})

test('split and glued frames', () => {
  const a = hexToBytes(vectors.empty_device_info_req)
  const b = hexToBytes(vectors.ack_ok_json)
  const parser = new CdcParser()
  expect(parser.feed(a.subarray(0, 10))).toHaveLength(0)
  expect(parser.feed(a.subarray(10))).toHaveLength(1)
  const glued = new Uint8Array(a.length + b.length)
  glued.set(a)
  glued.set(b, a.length)
  const p2 = new CdcParser()
  const frames = p2.feed(glued)
  expect(frames).toHaveLength(2)
  expect(frames[0]?.payload.length).toBe(0)
  expect(frames[1]?.flags).toBe(VB_CDC_F.ACK)
})

test('crc32 matches ieee golden body', () => {
  const raw = hexToBytes(vectors.empty_device_info_req)
  const body = raw.subarray(0, raw.length - 4)
  expect(crc32Ieee(body).toString(16).padStart(8, '0')).toBe(vectors.crc32_empty_req_body)
})
