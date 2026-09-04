import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  VB_CDC_CH,
  VB_CDC_CMD,
  VB_CDC_ERR,
  VB_CDC_EVT,
  VB_CDC_F,
  VB_CDC_PROTO_VERSION,
  VB_USB_PID,
  VB_USB_VID,
  type VbCdcFrame
} from '../../shared/cdc-file-protocol'
import { CdcParser, encodeFrame } from '../../shared/cdc-frame'
import type {
  DeviceCapacity,
  DeviceInfo,
  DeviceLogEvent,
  DevicePluginRow,
  DeviceProgressEvent,
  DeviceReadFileResult,
  DeviceWriteFile
} from '../../shared/device-ipc'
import {
  assertCanSaveAsText,
  classifyFile,
  isExamplesPlugin,
  isNativePlugin,
  isSystemPlugin,
  nestFilePaths,
  parseFileListResponse,
  parsePluginListResponse,
  type FileListItem,
  type FileTreeNode
} from '../../shared/plugin-files'
import { HandshakeError, verifyHandshake } from './handshake'

export class DeviceRpcError extends Error {
  readonly err: number
  readonly file?: string
  readonly line?: number
  readonly payload: unknown

  constructor(
    detail: string,
    err: number,
    extra?: { file?: string; line?: number; payload?: unknown }
  ) {
    super(`CDC_ERR ${err}: ${detail}`)
    this.name = 'DeviceRpcError'
    this.err = err
    this.file = extra?.file
    this.line = extra?.line
    this.payload = extra?.payload
  }
}

export type ListedPort = {
  path: string
  vendorId?: string
  productId?: string
  serialNumber?: string
}

export type OpenPort = {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  onData(cb: (data: Uint8Array) => void): void
  onError(cb: (err: Error) => void): void
  onClose(cb: () => void): void
}

export type SerialBinding = {
  list(): Promise<ListedPort[]>
  open(path: string, baudRate: number): Promise<OpenPort>
}

type Pending = {
  resolve: (frame: VbCdcFrame) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Session = {
  port: OpenPort
  parser: CdcParser
  activeTxn?: number
  pluginMeta: Map<string, DevicePluginRow>
}

export type DeviceManagerDeps = {
  binding?: SerialBinding
  frameTimeoutMs?: number
  txnTimeoutMs?: number
  maxRetries?: number
  pollMs?: number
}

const CHUNK = 1000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function jsonBytes(payload: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(payload ?? {}))
}

function parseJson(frame: VbCdcFrame): unknown {
  if (frame.payload.length === 0) return {}
  const text = decoder.decode(frame.payload)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function packChunk(offset: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length)
  out[0] = offset & 0xff
  out[1] = (offset >>> 8) & 0xff
  out[2] = (offset >>> 16) & 0xff
  out[3] = (offset >>> 24) & 0xff
  out[4] = data.length & 0xff
  out[5] = (data.length >>> 8) & 0xff
  out[6] = (data.length >>> 16) & 0xff
  out[7] = (data.length >>> 24) & 0xff
  out.set(data, 8)
  return out
}

function toUint8(data: string | number[] | Uint8Array, path: string): Uint8Array {
  if (typeof data === 'string') {
    assertCanSaveAsText(path, data)
    return encoder.encode(data)
  }
  if (data instanceof Uint8Array) return data
  return Uint8Array.from(data)
}

function fileChannel(command: number): number {
  return command === VB_CDC_CMD.FILE_WRITE_CHUNK || command === VB_CDC_CMD.FILE_READ_CHUNK
    ? VB_CDC_CH.FILE
    : VB_CDC_CH.RPC
}

function pendingKey(id: string, txn: number, command: number, seq: number): string {
  return `${id}:${txn}:${command}:${seq}`
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function toPromise(fn: (cb: (err?: Error | null) => void) => unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err?: Error | null): void => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const ret = fn(done)
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      void (ret as Promise<void>).then(() => done(), done)
    }
  })
}

async function defaultBinding(): Promise<SerialBinding> {
  const mod = (await import('serialport')) as {
    SerialPort: {
      list(): Promise<ListedPort[]>
      new (opts: { path: string; baudRate: number; autoOpen?: boolean }): {
        open(cb?: (err?: Error | null) => void): unknown
        close(cb?: (err?: Error | null) => void): unknown
        write(data: Buffer, cb: (err?: Error | null) => void): void
        on(ev: 'data', cb: (data: Buffer) => void): void
        on(ev: 'error', cb: (err: Error) => void): void
        on(ev: 'close', cb: () => void): void
      }
    }
  }
  const { SerialPort } = mod
  return {
    list: () => SerialPort.list(),
    async open(path, baudRate) {
      const port = new SerialPort({ path, baudRate, autoOpen: false })
      await toPromise((cb) => port.open(cb))
      return {
        write: (data) =>
          new Promise<void>((resolve, reject) => {
            port.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()))
          }),
        close: () => toPromise((cb) => port.close(cb)),
        onData: (cb) => {
          port.on('data', (buf) => cb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)))
        },
        onError: (cb) => {
          port.on('error', cb)
        },
        onClose: (cb) => {
          port.on('close', cb)
        }
      }
    }
  }
}

function throwIfNack(frame: VbCdcFrame): void {
  if (!(frame.flags & VB_CDC_F.NACK)) return
  const payload = parseJson(frame)
  const o = asRecord(payload)
  const err = typeof o.err === 'number' ? o.err : VB_CDC_ERR.IO
  const message =
    typeof o.message === 'string'
      ? o.message
      : typeof payload === 'string'
        ? payload
        : 'nack'
  throw new DeviceRpcError(message, err, {
    file: typeof o.file === 'string' ? o.file : undefined,
    line: typeof o.line === 'number' ? o.line : undefined,
    payload
  })
}

export class DeviceManager extends EventEmitter {
  private readonly devices = new Map<string, DeviceInfo>()
  private readonly sessions = new Map<string, Session>()
  private readonly pending = new Map<string, Pending>()
  private txn = 1
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private loadedBinding: SerialBinding | undefined
  private readonly frameTimeoutMs: number
  private readonly txnTimeoutMs: number
  private readonly maxRetries: number

  constructor(private readonly deps: DeviceManagerDeps = {}) {
    super()
    this.frameTimeoutMs = deps.frameTimeoutMs ?? 5000
    this.txnTimeoutMs = deps.txnTimeoutMs ?? 60_000
    this.maxRetries = deps.maxRetries ?? 3
  }

  startPolling(ms = this.deps.pollMs ?? 2000): void {
    this.stopPolling()
    if (ms <= 0) return
    this.pollTimer = setInterval(() => {
      void this.list().catch(() => undefined)
    }, ms)
    void this.list().catch(() => undefined)
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  async dispose(): Promise<void> {
    this.stopPolling()
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      await this.disconnect(id).catch(() => undefined)
    }
  }

  private async binding(): Promise<SerialBinding> {
    if (this.deps.binding) return this.deps.binding
    if (!this.loadedBinding) this.loadedBinding = await defaultBinding()
    return this.loadedBinding
  }

  async list(): Promise<DeviceInfo[]> {
    try {
      const ports = await (await this.binding()).list()
      const seen = new Set<string>()
      const found: DeviceInfo[] = []
      for (const p of ports) {
        const vid = Number.parseInt(p.vendorId ?? '', 16)
        const pid = Number.parseInt(p.productId ?? '', 16)
        if (vid !== VB_USB_VID || pid !== VB_USB_PID) continue
        const serial = p.serialNumber || p.path
        seen.add(serial)
        const prev = this.devices.get(serial)
        const info: DeviceInfo = {
          ...(prev ?? {
            id: serial,
            serial,
            connected: false
          }),
          id: prev?.id ?? serial,
          path: p.path,
          serial: prev?.serial ?? serial,
          connected: prev?.connected ?? false
        }
        this.devices.set(info.id, info)
        found.push(info)
      }
      for (const [id, info] of this.devices) {
        if (!seen.has(id) && !seen.has(info.serial)) {
          if (info.connected) {
            await this.disconnect(id).catch(() => undefined)
          }
          this.devices.delete(id)
        }
      }
      const list = [...this.devices.values()]
      this.emit('changed', list)
      return list
    } catch {
      return [...this.devices.values()]
    }
  }

  async connect(id: string): Promise<DeviceInfo> {
    await this.list()
    const info = this.devices.get(id)
    if (!info) throw new Error('device not found')
    if (this.sessions.has(id)) {
      await this.disconnect(id)
    }
    const binding = await this.binding()
    const port = await binding.open(info.path, 115200)
    const session: Session = {
      port,
      parser: new CdcParser(),
      pluginMeta: new Map()
    }
    this.sessions.set(id, session)
    port.onData((buf) => this.onBytes(id, buf))
    port.onError((err) => {
      info.lastError = err.message
      info.connected = false
      void this.disconnect(id).catch(() => undefined)
    })
    port.onClose(() => {
      if (this.sessions.get(id)?.port === port) {
        info.connected = false
        this.rejectPending(id, new Error('disconnected'))
        this.sessions.delete(id)
        this.emit('changed', [...this.devices.values()])
      }
    })
    try {
      const raw = asRecord(await this.rpc(id, VB_CDC_CMD.DEVICE_INFO, {}))
      const verified = verifyHandshake(info.serial, raw)
      info.proto = verified.proto
      info.protoCompatible = verified.proto === VB_CDC_PROTO_VERSION
      info.fwVersion = verified.fwVersion
      info.chip = verified.chip
      info.hid = verified.hid
      info.touchRoute = verified.touchRoute
      info.capabilities = verified.capabilities
      info.serial = verified.serial
      info.lastError = undefined
      if (verified.capacity) info.capacity = verified.capacity
      await this.rpc(id, VB_CDC_CMD.LOG_SUBSCRIBE, { enable: true })
      if (!info.capacity) {
        try {
          info.capacity = await this.capacity(id)
        } catch {
          /* optional */
        }
      }
      info.connected = true
      this.emit('changed', [...this.devices.values()])
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      info.lastError = message
      info.connected = false
      info.protoCompatible = false
      await this.disconnect(id).catch(() => undefined)
      throw error
    }
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id)
    this.rejectPending(id, new Error('disconnected'))
    this.sessions.delete(id)
    if (session) {
      session.parser = new CdcParser()
      session.activeTxn = undefined
      await session.port.close().catch(() => undefined)
    }
    const info = this.devices.get(id)
    if (info) info.connected = false
    this.emit('changed', [...this.devices.values()])
  }

  async abort(id: string): Promise<void> {
    const session = this.sessions.get(id)
    const txns = new Set<number>()
    const prefix = `${id}:`
    for (const key of this.pending.keys()) {
      if (!key.startsWith(prefix)) continue
      const txn = Number(key.split(':')[1])
      if (Number.isFinite(txn)) txns.add(txn)
    }
    if (session?.activeTxn !== undefined) txns.add(session.activeTxn)
    this.rejectPending(id, new Error('cancelled'))
    if (session) {
      session.parser = new CdcParser()
      session.activeTxn = undefined
    }
    if (!this.sessions.has(id)) return
    for (const txn of txns) {
      try {
        await this.sendCancel(id, txn)
      } catch {
        /* best effort */
      }
    }
  }

  private onBytes(id: string, buf: Uint8Array): void {
    const session = this.sessions.get(id)
    if (!session) return
    for (const frame of session.parser.feed(buf)) {
      if (frame.channel === VB_CDC_CH.EVENT || frame.flags & VB_CDC_F.EVENT) {
        this.handleEvent(id, frame)
        continue
      }
      const key = pendingKey(id, frame.txnId, frame.command, frame.seq)
      const wait = this.pending.get(key)
      if (wait) {
        clearTimeout(wait.timer)
        this.pending.delete(key)
        wait.resolve(frame)
      }
    }
  }

  private handleEvent(id: string, frame: VbCdcFrame): void {
    const text = decoder.decode(frame.payload)
    if (frame.command === VB_CDC_EVT.TXN_PROGRESS || frame.command === VB_CDC_EVT.TXN_RESULT) {
      const o = asRecord(text.startsWith('{') ? parseJson(frame) : {})
      const event: DeviceProgressEvent = {
        deviceId: id,
        plugin: typeof o.plugin === 'string' ? o.plugin : undefined,
        path: typeof o.path === 'string' ? o.path : undefined,
        phase: frame.command === VB_CDC_EVT.TXN_RESULT ? 'result' : 'progress',
        offset: typeof o.offset === 'number' ? o.offset : undefined,
        total: typeof o.total === 'number' ? o.total : undefined,
        percent: typeof o.percent === 'number' ? o.percent : undefined,
        message: typeof o.message === 'string' ? o.message : text
      }
      this.emit('progress', event)
      return
    }
    const log: DeviceLogEvent = { deviceId: id, line: text }
    this.emit('log', log)
  }

  private rejectPending(id: string, err: Error): void {
    const prefix = `${id}:`
    for (const [key, wait] of this.pending) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(wait.timer)
      this.pending.delete(key)
      wait.reject(err)
    }
  }

  private nextTxn(): number {
    const txn = this.txn++
    if (this.txn > 0x7fffffff) this.txn = 1
    return txn
  }

  private async rpcFrame(
    id: string,
    command: number,
    payload: Uint8Array,
    opts?: { txn?: number; seq?: number; retries?: number; cancelOnFail?: boolean }
  ): Promise<VbCdcFrame> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`device ${id} not connected`)
    const txn = opts?.txn ?? this.nextTxn()
    const seq = opts?.seq ?? 0
    const key = pendingKey(id, txn, command, seq)
    const raw = encodeFrame({
      version: VB_CDC_PROTO_VERSION,
      channel: fileChannel(command),
      command,
      flags: 0,
      txnId: txn,
      seq,
      payload
    })
    const attempts = opts?.retries ?? this.maxRetries
    let lastErr: Error = new Error('timeout')
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const reply = await this.sendAndWait(session, key, raw)
        throwIfNack(reply)
        return reply
      } catch (error) {
        lastErr = error instanceof Error ? error : new Error(String(error))
        if (
          lastErr.message === 'cancelled' ||
          lastErr.message === 'disconnected' ||
          lastErr instanceof DeviceRpcError ||
          lastErr instanceof HandshakeError
        ) {
          throw lastErr
        }
      }
    }
    if (opts?.cancelOnFail !== false && command !== VB_CDC_CMD.CANCEL) {
      try {
        await this.sendCancel(id, txn)
      } catch {
        /* ignore */
      }
    }
    throw lastErr
  }

  private sendCancel(id: string, txn: number): Promise<VbCdcFrame> {
    return this.rpcFrame(id, VB_CDC_CMD.CANCEL, jsonBytes({ txn_id: txn }), {
      retries: 1,
      cancelOnFail: false
    })
  }

  private sendAndWait(session: Session, key: string, raw: Uint8Array): Promise<VbCdcFrame> {
    return new Promise<VbCdcFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error('timeout'))
      }, this.frameTimeoutMs)
      this.pending.set(key, { resolve, reject, timer })
      void session.port.write(raw).catch((err: unknown) => {
        clearTimeout(timer)
        this.pending.delete(key)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  async rpc(id: string, command: number, payload: unknown = {}): Promise<unknown> {
    const reply = await this.rpcFrame(id, command, jsonBytes(payload))
    return parseJson(reply)
  }

  private emitProgress(event: DeviceProgressEvent): void {
    this.emit('progress', event)
  }

  pluginList(id: string): Promise<DevicePluginRow[]> {
    return this.rpc(id, VB_CDC_CMD.PLUGIN_LIST, {}).then((raw) => {
      const list = parsePluginListResponse(raw) as DevicePluginRow[]
      const session = this.sessions.get(id)
      if (session) {
        session.pluginMeta.clear()
        for (const row of list) session.pluginMeta.set(row.id, row)
      }
      return list
    })
  }

  async capacity(id: string): Promise<DeviceCapacity> {
    const raw = asRecord(await this.rpc(id, VB_CDC_CMD.CAPACITY, {}))
    const cap = {
      total: Number(raw.total ?? 0),
      used: Number(raw.used ?? 0),
      free: Number(raw.free ?? 0)
    }
    const info = this.devices.get(id)
    if (info) info.capacity = cap
    return cap
  }

  private guardFileRpc(id: string, plugin: string, write: boolean): void {
    if (isSystemPlugin(plugin)) {
      throw new DeviceRpcError('system plugins are hidden', VB_CDC_ERR.SYSTEM_HIDDEN)
    }
    const meta = this.sessions.get(id)?.pluginMeta.get(plugin)
    if (isNativePlugin(meta ?? { id: plugin })) {
      throw new DeviceRpcError('native plugin does not support file RPC', VB_CDC_ERR.NATIVE_PLUGIN)
    }
    if (write && (isExamplesPlugin(plugin) || meta?.readonly)) {
      throw new DeviceRpcError('examples plugins are read-only', VB_CDC_ERR.READONLY)
    }
  }

  async fileList(
    id: string,
    plugin: string,
    path?: string,
    recursive = false
  ): Promise<FileListItem[]> {
    this.guardFileRpc(id, plugin, false)
    const listDir = async (dir?: string): Promise<FileListItem[]> => {
      const entries: FileListItem[] = []
      let cursor: string | undefined
      do {
        const raw = await this.rpc(id, VB_CDC_CMD.FILE_LIST, {
          plugin,
          path: dir,
          cursor
        })
        const page = parseFileListResponse(raw)
        entries.push(...page.entries)
        cursor = page.complete ? undefined : page.cursor
      } while (cursor)
      return entries
    }
    if (!recursive) {
      const entries = await listDir(path)
      return entries.map((e) => ({
        ...e,
        path: e.path ?? (path ? `${path}/${e.name}` : e.name)
      }))
    }
    const all: FileListItem[] = []
    const walk = async (dir?: string): Promise<void> => {
      const entries = await listDir(dir)
      for (const e of entries) {
        const rel = e.path ?? (dir ? `${dir}/${e.name}` : e.name)
        all.push({ ...e, path: rel })
        if (e.type === 'dir') await walk(rel)
      }
    }
    await walk(path)
    return all
  }

  async fileTree(id: string, plugin: string): Promise<FileTreeNode[]> {
    const entries = await this.fileList(id, plugin, undefined, true)
    return nestFilePaths(entries)
  }

  setTouchRoute(id: string, route: 'local_ui' | 'usb_touchpad'): Promise<unknown> {
    return this.rpc(id, VB_CDC_CMD.TOUCH_ROUTE_SET, { route }).then((raw) => {
      const info = this.devices.get(id)
      if (info) info.touchRoute = route
      return raw
    })
  }

  mkdir(id: string, plugin: string, path: string, generation: number): Promise<unknown> {
    this.guardFileRpc(id, plugin, true)
    return this.rpc(id, VB_CDC_CMD.MKDIR, { plugin, path, generation })
  }

  rename(
    id: string,
    plugin: string,
    from: string,
    to: string,
    generation: number
  ): Promise<unknown> {
    this.guardFileRpc(id, plugin, true)
    return this.rpc(id, VB_CDC_CMD.RENAME, { plugin, from, to, generation })
  }

  deletePath(id: string, plugin: string, path: string, generation: number): Promise<unknown> {
    this.guardFileRpc(id, plugin, true)
    return this.rpc(id, VB_CDC_CMD.DELETE, { plugin, path, generation })
  }

  async readFile(id: string, plugin: string, path: string): Promise<DeviceReadFileResult> {
    this.guardFileRpc(id, plugin, false)
    const begin = asRecord(await this.rpc(id, VB_CDC_CMD.FILE_READ_BEGIN, { plugin, path }))
    const size = Number(begin.size ?? 0)
    const chunks: number[] = []
    let offset = 0
    while (offset < size) {
      const n = Math.min(CHUNK, size - offset)
      const payload = packChunk(offset, new Uint8Array(n)).subarray(0, 8)
      payload[4] = n & 0xff
      payload[5] = (n >>> 8) & 0xff
      payload[6] = (n >>> 16) & 0xff
      payload[7] = (n >>> 24) & 0xff
      const reply = await this.rpcFrame(id, VB_CDC_CMD.FILE_READ_CHUNK, payload)
      const data = reply.payload.subarray(8)
      for (const b of data) chunks.push(b)
      offset += data.length
      if (data.length === 0) break
    }
    const bytes = Uint8Array.from(chunks)
    const kind = classifyFile(path, bytes)
    if (kind === 'text') {
      return { text: decoder.decode(bytes), encoding: 'utf8' }
    }
    return { bytes: [...bytes], encoding: kind === 'image' ? 'image' : 'binary' }
  }

  async writeFile(
    id: string,
    plugin: string,
    path: string,
    data: Uint8Array,
    run: boolean,
    generation?: number
  ): Promise<{ generation?: number }> {
    return this.writeFiles(id, plugin, [{ path, data }], { run, generation })
  }

  async writeFiles(
    id: string,
    plugin: string,
    files: Array<DeviceWriteFile | { path: string; data: string | number[] | Uint8Array }>,
    opts: { run: boolean; generation?: number }
  ): Promise<{ generation?: number }> {
    this.guardFileRpc(id, plugin, true)
    const prepared = files.map((file) => ({
      path: file.path,
      bytes: toUint8(file.data, file.path)
    }))
    let generation = opts.generation
    if (generation === undefined) {
      const plugins = await this.pluginList(id)
      const row = plugins.find((p) => p.id === plugin)
      if (row && typeof row.generation === 'number') {
        generation = row.generation
      } else {
        throw new Error('generation unknown; refuse to send 0')
      }
    }
    const session = this.sessions.get(id)
    if (!session) throw new Error(`device ${id} not connected`)
    const txn = this.nextTxn()
    session.activeTxn = txn
    let seq = 0
    const nextSeq = (): number => seq++
    const txnTimer = setTimeout(() => {
      void this.abort(id)
    }, this.txnTimeoutMs)
    try {
      this.emitProgress({ deviceId: id, plugin, phase: 'txn_begin' })
      await this.rpcFrame(id, VB_CDC_CMD.TXN_BEGIN, jsonBytes({ plugin, generation }), {
        txn,
        seq: nextSeq()
      })
      for (const file of prepared) {
        const sha = sha256Hex(file.bytes)
        this.emitProgress({
          deviceId: id,
          plugin,
          path: file.path,
          phase: 'write',
          offset: 0,
          total: file.bytes.length
        })
        await this.rpcFrame(
          id,
          VB_CDC_CMD.FILE_WRITE_BEGIN,
          jsonBytes({
            plugin,
            path: file.path,
            size: file.bytes.length,
            sha256: sha,
            generation
          }),
          { txn, seq: nextSeq() }
        )
        let offset = 0
        while (offset < file.bytes.length) {
          const n = Math.min(CHUNK, file.bytes.length - offset)
          const chunk = file.bytes.subarray(offset, offset + n)
          await this.rpcFrame(id, VB_CDC_CMD.FILE_WRITE_CHUNK, packChunk(offset, chunk), {
            txn,
            seq: nextSeq()
          })
          offset += n
          this.emitProgress({
            deviceId: id,
            plugin,
            path: file.path,
            phase: 'write',
            offset,
            total: file.bytes.length,
            percent: file.bytes.length ? Math.round((offset / file.bytes.length) * 100) : 100
          })
        }
        await this.rpcFrame(id, VB_CDC_CMD.FILE_WRITE_COMMIT, jsonBytes({ plugin, path: file.path }), {
          txn,
          seq: nextSeq()
        })
      }
      this.emitProgress({ deviceId: id, plugin, phase: 'validate' })
      await this.rpcFrame(id, VB_CDC_CMD.BUNDLE_VALIDATE, jsonBytes({ plugin }), {
        txn,
        seq: nextSeq()
      })
      this.emitProgress({
        deviceId: id,
        plugin,
        phase: 'activate',
        message: opts.run ? 'save-and-run' : 'save'
      })
      const activate = asRecord(
        parseJson(
          await this.rpcFrame(
            id,
            VB_CDC_CMD.BUNDLE_ACTIVATE,
            jsonBytes({ plugin, generation, run: opts.run }),
            { txn, seq: nextSeq() }
          )
        )
      )
      const nextGen =
        typeof activate.generation === 'number' ? activate.generation : generation
      const row = session.pluginMeta.get(plugin)
      if (row && nextGen !== undefined) row.generation = nextGen
      this.emitProgress({ deviceId: id, plugin, phase: 'done', percent: 100 })
      return { generation: nextGen }
    } finally {
      clearTimeout(txnTimer)
      if (session.activeTxn === txn) session.activeTxn = undefined
    }
  }
}

export { nestFilePaths, parseFileListResponse }
