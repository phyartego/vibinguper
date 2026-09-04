import { expect, test } from '@playwright/test'
import {
  VB_CDC_CH,
  VB_CDC_CMD,
  VB_CDC_ERR,
  VB_CDC_EVT,
  VB_CDC_F,
  type VbCdcFrame
} from '../shared/cdc-file-protocol'
import { CdcParser, encodeFrame } from '../shared/cdc-frame'
import {
  DeviceManager,
  DeviceRpcError,
  type OpenPort,
  type SerialBinding
} from '../electron/device/DeviceManager'
import { HandshakeError, verifyHandshake } from '../electron/device/handshake'
import { saveFailureState } from '../shared/plugin-files'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function jsonPayload(frame: VbCdcFrame): Record<string, unknown> {
  if (frame.payload.length === 0) return {}
  try {
    return JSON.parse(decoder.decode(frame.payload)) as Record<string, unknown>
  } catch {
    return {}
  }
}

function reply(
  req: VbCdcFrame,
  payload: unknown,
  flags = VB_CDC_F.ACK,
  channel = VB_CDC_CH.RPC
): VbCdcFrame {
  const body =
    payload instanceof Uint8Array
      ? payload
      : encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload))
  return {
    version: 1,
    channel,
    command: req.command,
    flags,
    txnId: req.txnId,
    seq: req.seq,
    payload: body
  }
}

class FakePort implements OpenPort {
  readonly writes: VbCdcFrame[] = []
  delayMs = 0
  silentCommands = new Set<number>()
  failTimes = new Map<number, number>()
  closed = false
  private readonly parser = new CdcParser()
  private dataCb: ((data: Uint8Array) => void) | undefined
  private closeCb: (() => void) | undefined

  constructor(private readonly handle: (frame: VbCdcFrame) => VbCdcFrame | VbCdcFrame[] | null) {}

  async write(data: Uint8Array): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    for (const frame of this.parser.feed(data)) {
      this.writes.push(frame)
      const left = this.failTimes.get(frame.command) ?? 0
      if (left > 0) {
        this.failTimes.set(frame.command, left - 1)
        continue
      }
      if (this.silentCommands.has(frame.command)) continue
      const out = this.handle(frame)
      if (!out) continue
      const list = Array.isArray(out) ? out : [out]
      queueMicrotask(() => {
        for (const item of list) this.dataCb?.(encodeFrame(item))
      })
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.closeCb?.()
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb
  }

  onError(): void {}

  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  push(frame: VbCdcFrame): void {
    this.dataCb?.(encodeFrame(frame))
  }
}

function makeBinding(
  port: FakePort,
  listed: Array<{ path: string; vendorId?: string; productId?: string; serialNumber?: string }> = [
    { path: 'COM9', vendorId: '303A', productId: '1001', serialNumber: 'VBTEST' }
  ]
): SerialBinding {
  return {
    list: async () => listed,
    open: async () => port
  }
}

function vibingDevice(overrides?: {
  proto?: number
  serial?: string | null
  capabilities?: string[] | null
  files?: Map<string, Uint8Array>
  dirs?: Map<string, Array<{ name: string; type: 'file' | 'dir'; size: number }>>
  activateErr?: number
  conflict?: boolean
}): { port: FakePort; files: Map<string, Uint8Array> } {
  const files =
    overrides?.files ??
    new Map<string, Uint8Array>([['main.py', encoder.encode('print(1)')]])
  const dirs =
    overrides?.dirs ??
    new Map([
      ['', [{ name: 'main.py', type: 'file' as const, size: 8 }, { name: 'assets', type: 'dir' as const, size: 0 }]],
      ['assets', [{ name: 'a.png', type: 'file' as const, size: 4 }]]
    ])
  files.set('assets/a.png', new Uint8Array([1, 2, 3, 4]))
  let readPath = 'main.py'
  const port = new FakePort((frame) => {
    const body = jsonPayload(frame)
    switch (frame.command) {
      case VB_CDC_CMD.DEVICE_INFO: {
        const payload: Record<string, unknown> = {
          ok: true,
          proto: overrides?.proto ?? 1,
          fw_version: '1.2.3',
          hid: { kbd: true },
          touch_route: 'local_ui',
          capacity: { total: 4096, used: 128, free: 3968 }
        }
        if (overrides?.serial !== null) payload.serial = overrides?.serial ?? 'VBTEST'
        if (overrides?.capabilities !== null) {
          payload.capabilities = overrides?.capabilities ?? ['file', 'plugin']
        }
        return reply(frame, payload)
      }
      case VB_CDC_CMD.LOG_SUBSCRIBE:
        queueMicrotask(() => {
          port.push({
            version: 1,
            channel: VB_CDC_CH.EVENT,
            command: VB_CDC_EVT.LOG,
            flags: VB_CDC_F.EVENT,
            txnId: 0,
            seq: 0,
            payload: encoder.encode('boot ok')
          })
        })
        return reply(frame, { ok: true })
      case VB_CDC_CMD.CAPACITY:
        return reply(frame, { total: 4096, used: 128, free: 3968 })
      case VB_CDC_CMD.PLUGIN_LIST:
        return reply(frame, [
          { id: 'clock', native: true, running: true },
          { id: 'system', native: false },
          { id: 'examples', native: false, readonly: true, generation: 1 },
          { id: 'hello_tick', native: false, generation: 42, running: false, version: 3 }
        ])
      case VB_CDC_CMD.FILE_LIST: {
        const path = typeof body.path === 'string' ? body.path : ''
        if (!body.cursor) {
          return reply(frame, {
            entries: dirs.get(path)?.slice(0, 1) ?? [],
            cursor: 'p2'
          })
        }
        return reply(frame, {
          entries: dirs.get(path)?.slice(1) ?? [],
          complete: true
        })
      }
      case VB_CDC_CMD.FILE_READ_BEGIN: {
        readPath = String(body.path)
        const data = files.get(readPath) ?? new Uint8Array()
        return reply(frame, { size: data.length, sha256: 'ab' })
      }
      case VB_CDC_CMD.FILE_READ_CHUNK: {
        const offset =
          frame.payload[0]! |
          (frame.payload[1]! << 8) |
          (frame.payload[2]! << 16) |
          (frame.payload[3]! << 24)
        const data = files.get(readPath) ?? new Uint8Array()
        const slice = data.subarray(offset, offset + 1000)
        const packed = new Uint8Array(8 + slice.length)
        packed.set(frame.payload.subarray(0, 4), 0)
        packed[4] = slice.length & 0xff
        packed[5] = (slice.length >>> 8) & 0xff
        packed.set(slice, 8)
        return reply(frame, packed, VB_CDC_F.ACK, VB_CDC_CH.FILE)
      }
      case VB_CDC_CMD.TXN_BEGIN:
        if (overrides?.conflict) {
          return reply(frame, { err: VB_CDC_ERR.CONFLICT_GEN, message: 'stale' }, VB_CDC_F.NACK)
        }
        queueMicrotask(() => {
          port.push({
            version: 1,
            channel: VB_CDC_CH.EVENT,
            command: VB_CDC_EVT.TXN_PROGRESS,
            flags: VB_CDC_F.EVENT,
            txnId: frame.txnId,
            seq: 0,
            payload: encoder.encode(JSON.stringify({ percent: 10, plugin: 'hello_tick' }))
          })
        })
        return reply(frame, { ok: true, generation: 42 })
      case VB_CDC_CMD.FILE_WRITE_BEGIN:
      case VB_CDC_CMD.FILE_WRITE_CHUNK:
      case VB_CDC_CMD.FILE_WRITE_COMMIT:
      case VB_CDC_CMD.BUNDLE_VALIDATE:
        return reply(frame, { ok: true })
      case VB_CDC_CMD.BUNDLE_ACTIVATE:
        if (overrides?.activateErr) {
          return reply(
            frame,
            { err: overrides.activateErr, message: 'vm exploded' },
            VB_CDC_F.NACK
          )
        }
        return reply(frame, { ok: true, generation: 43 })
      case VB_CDC_CMD.CANCEL:
        return reply(frame, { ok: true })
      case VB_CDC_CMD.MKDIR:
      case VB_CDC_CMD.RENAME:
      case VB_CDC_CMD.DELETE:
        return reply(frame, { ok: true })
      default:
        return reply(frame, { err: VB_CDC_ERR.UNKNOWN_CMD, message: 'unknown' }, VB_CDC_F.NACK)
    }
  })
  return { port, files }
}

test('handshake rejects wrong proto, missing serial, missing cap', () => {
  expect(() =>
    verifyHandshake('VBTEST', { proto: 2, serial: 'VBTEST', capabilities: ['file', 'plugin'] })
  ).toThrow(HandshakeError)
  expect(() =>
    verifyHandshake('VBTEST', { proto: 1, capabilities: ['file', 'plugin'] })
  ).toThrow(/missing serial/)
  expect(() => verifyHandshake('VBTEST', { proto: 1, serial: 'VBTEST' })).toThrow(
    /missing file\/plugin/
  )
  expect(
    verifyHandshake('VBTEST', {
      proto: 1,
      serial: 'VBTEST',
      capabilities: ['file', 'plugin'],
      fw_version: '1.2.3'
    }).fwVersion
  ).toBe('1.2.3')
  expect(
    verifyHandshake('VBABCDEF', {
      proto: 1,
      serial: 'VBABCDEF',
      capabilities: ['cdc_rpc', 'file_rpc', 'plugin_rpc', 'plugin_fs', 'txn']
    }).serial
  ).toBe('VBABCDEF')
})

test('DeviceManager handshake stores info and VID/PID is only a filter', async () => {
  const { port } = vibingDevice()
  const logs: string[] = []
  const mgr = new DeviceManager({
    binding: makeBinding(port, [
      { path: 'COM1', vendorId: '1234', productId: '0001', serialNumber: 'OTHER' },
      { path: 'COM9', vendorId: '303A', productId: '1001', serialNumber: 'VBTEST' }
    ]),
    frameTimeoutMs: 200,
    maxRetries: 2
  })
  mgr.on('log', (ev) => logs.push(ev.line))
  const listed = await mgr.list()
  expect(listed).toHaveLength(1)
  expect(listed[0]?.connected).toBe(false)
  const info = await mgr.connect('VBTEST')
  expect(info.connected).toBe(true)
  expect(info.protoCompatible).toBe(true)
  expect(info.fwVersion).toBe('1.2.3')
  expect(info.capacity?.total).toBe(4096)
  expect(info.hid).toEqual({ kbd: true })
  expect(info.touchRoute).toBe('local_ui')
  await expect.poll(() => logs.join('\n')).toContain('boot ok')
  await mgr.dispose()
})

test('incompatible DEVICE_INFO disconnects', async () => {
  const { port } = vibingDevice({ proto: 9 })
  const mgr = new DeviceManager({
    binding: makeBinding(port),
    frameTimeoutMs: 200
  })
  await expect(mgr.connect('VBTEST')).rejects.toThrow(/incompatible protocol/)
  expect(port.closed).toBe(true)
  await mgr.dispose()
})

test('retries then succeeds; timeout and disconnect reject pending', async () => {
  const { port } = vibingDevice()
  port.failTimes.set(VB_CDC_CMD.DEVICE_INFO, 2)
  const mgr = new DeviceManager({
    binding: makeBinding(port),
    frameTimeoutMs: 40,
    maxRetries: 3
  })
  await mgr.connect('VBTEST')
  const infoHits = port.writes.filter((f) => f.command === VB_CDC_CMD.DEVICE_INFO)
  expect(infoHits.length).toBe(3)

  port.silentCommands.add(VB_CDC_CMD.CAPACITY)
  const pending = mgr.capacity('VBTEST')
  await expect(pending).rejects.toThrow(/timeout|cancelled/)

  port.silentCommands.delete(VB_CDC_CMD.CAPACITY)
  port.delayMs = 80
  const slow = mgr.pluginList('VBTEST')
  await mgr.disconnect('VBTEST')
  await expect(slow).rejects.toThrow(/disconnected|cancelled/)
  await mgr.dispose()
})

test('abort sends CANCEL', async () => {
  const { port } = vibingDevice()
  const mgr = new DeviceManager({
    binding: makeBinding(port),
    frameTimeoutMs: 200,
    maxRetries: 1
  })
  await mgr.connect('VBTEST')
  port.delayMs = 60
  const pending = mgr.fileList('VBTEST', 'hello_tick')
  const pendingRejected = expect(pending).rejects.toThrow(/cancelled|timeout/)
  await new Promise((r) => setTimeout(r, 10))
  await mgr.abort('VBTEST')
  await pendingRejected
  expect(port.writes.some((f) => f.command === VB_CDC_CMD.CANCEL)).toBe(true)
  await mgr.dispose()
})

test('file list pagination and multi-directory tree', async () => {
  const { port } = vibingDevice()
  const mgr = new DeviceManager({ binding: makeBinding(port), frameTimeoutMs: 200 })
  await mgr.connect('VBTEST')
  const plugins = await mgr.pluginList('VBTEST')
  expect(plugins.some((p) => p.id === 'system')).toBe(false)
  expect(plugins.find((p) => p.id === 'clock')?.native).toBe(true)
  const tree = await mgr.fileTree('VBTEST', 'hello_tick')
  expect(tree.some((n) => n.path === 'main.py' || n.name === 'main.py')).toBe(true)
  expect(tree.some((n) => n.name === 'assets')).toBe(true)
  await expect(mgr.fileList('VBTEST', 'clock')).rejects.toThrow(/native/)
  await expect(mgr.fileList('VBTEST', 'system')).rejects.toThrow(/hidden/)
  await mgr.dispose()
})

test('text save uses TXN_BEGIN and activate run:false; binary cannot text-save', async () => {
  const { port } = vibingDevice()
  const mgr = new DeviceManager({ binding: makeBinding(port), frameTimeoutMs: 200 })
  await mgr.connect('VBTEST')
  await mgr.pluginList('VBTEST')
  await expect(
    mgr.writeFiles('VBTEST', 'hello_tick', [{ path: 'icon.png', data: '[binary 4 bytes]' }], {
      run: false,
      generation: 42
    })
  ).rejects.toThrow(/UTF-8/)
  expect(port.writes.some((f) => f.command === VB_CDC_CMD.TXN_BEGIN)).toBe(false)

  const result = await mgr.writeFiles(
    'VBTEST',
    'hello_tick',
    [{ path: 'main.py', data: 'print(2)' }],
    { run: false, generation: 42 }
  )
  expect(result.generation).toBe(43)
  const cmds = port.writes.map((f) => f.command)
  expect(cmds).toContain(VB_CDC_CMD.TXN_BEGIN)
  expect(cmds).toContain(VB_CDC_CMD.FILE_WRITE_BEGIN)
  expect(cmds).toContain(VB_CDC_CMD.FILE_WRITE_CHUNK)
  expect(cmds).toContain(VB_CDC_CMD.FILE_WRITE_COMMIT)
  expect(cmds).toContain(VB_CDC_CMD.BUNDLE_VALIDATE)
  expect(cmds).toContain(VB_CDC_CMD.BUNDLE_ACTIVATE)
  const begin = port.writes.find((f) => f.command === VB_CDC_CMD.TXN_BEGIN)
  expect(jsonPayload(begin!).generation).toBe(42)
  const activate = port.writes.find((f) => f.command === VB_CDC_CMD.BUNDLE_ACTIVATE)
  expect(jsonPayload(activate!).run).toBe(false)
  await expect(
    mgr.writeFiles('VBTEST', 'examples', [{ path: 'main.py', data: 'x' }], {
      run: false,
      generation: 1
    })
  ).rejects.toThrow(/read-only/)
  await mgr.dispose()
})

test('image upload/download stays binary; generation conflict; save-and-run keeps editor text', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const { port, files } = vibingDevice()
  files.set('assets/a.png', png)
  const mgr = new DeviceManager({ binding: makeBinding(port), frameTimeoutMs: 200 })
  await mgr.connect('VBTEST')
  await mgr.pluginList('VBTEST')
  const read = await mgr.readFile('VBTEST', 'hello_tick', 'assets/a.png')
  expect(read.encoding).toBe('image')
  expect(read.text).toBeUndefined()
  expect(read.bytes?.slice(0, 4)).toEqual([...png])

  await mgr.writeFiles(
    'VBTEST',
    'hello_tick',
    [{ path: 'assets/a.png', data: [...png, 9] }],
    { run: false, generation: 42 }
  )
  const writeBegin = port.writes.filter((f) => f.command === VB_CDC_CMD.FILE_WRITE_BEGIN).pop()
  expect(jsonPayload(writeBegin!).path).toBe('assets/a.png')

  const conflicted = vibingDevice({ conflict: true })
  const mgr2 = new DeviceManager({
    binding: makeBinding(conflicted.port),
    frameTimeoutMs: 200
  })
  await mgr2.connect('VBTEST')
  await mgr2.pluginList('VBTEST')
  try {
    await mgr2.writeFiles('VBTEST', 'hello_tick', [{ path: 'main.py', data: 'x' }], {
      run: false,
      generation: 42
    })
    throw new Error('expected conflict')
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceRpcError)
    expect((error as DeviceRpcError).err).toBe(VB_CDC_ERR.CONFLICT_GEN)
  }

  const failing = vibingDevice({ activateErr: VB_CDC_ERR.VM_START_FAILED })
  const mgr3 = new DeviceManager({
    binding: makeBinding(failing.port),
    frameTimeoutMs: 200
  })
  await mgr3.connect('VBTEST')
  const editor = { text: 'print("keep")' }
  try {
    await mgr3.writeFiles('VBTEST', 'hello_tick', [{ path: 'main.py', data: editor.text }], {
      run: true,
      generation: 42
    })
    throw new Error('expected vm failure')
  } catch (error) {
    const state = saveFailureState(editor, error)
    expect(state.text).toBe('print("keep")')
    expect(state.dirty).toBe(true)
    expect(state.error).toContain('vm exploded')
  }
  const act = failing.port.writes.find((f) => f.command === VB_CDC_CMD.BUNDLE_ACTIVATE)
  expect(jsonPayload(act!).run).toBe(true)
  await mgr.dispose()
  await mgr2.dispose()
  await mgr3.dispose()
})

test('progress and log events are emitted', async () => {
  const { port } = vibingDevice()
  const mgr = new DeviceManager({ binding: makeBinding(port), frameTimeoutMs: 200 })
  const progress: string[] = []
  mgr.on('progress', (ev) => progress.push(ev.phase))
  await mgr.connect('VBTEST')
  await mgr.pluginList('VBTEST')
  await mgr.writeFiles('VBTEST', 'hello_tick', [{ path: 'main.py', data: 'print(3)' }], {
    run: false,
    generation: 42
  })
  expect(progress).toContain('txn_begin')
  expect(progress).toContain('progress')
  await mgr.dispose()
})
