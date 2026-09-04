export const DeviceInvokeChannel = {
  List: 'device:list',
  Connect: 'device:connect',
  Disconnect: 'device:disconnect',
  Rpc: 'device:rpc',
  SaveAndRun: 'device:saveAndRun',
  ReadFile: 'device:readFile',
  WriteFile: 'device:writeFile',
  TouchRoute: 'device:touchRoute',
  Capacity: 'device:capacity',
  PluginList: 'device:pluginList',
  FileList: 'device:fileList',
  Mkdir: 'device:mkdir',
  Rename: 'device:rename',
  Delete: 'device:delete',
  Abort: 'device:abort'
} as const

export const DeviceEventChannel = {
  Changed: 'device:changed',
  Log: 'device:log',
  Progress: 'device:progress'
} as const

export interface DeviceCapacity {
  total: number
  used: number
  free: number
}

export interface DeviceInfo {
  id: string
  path: string
  serial: string
  connected: boolean
  proto?: number
  protoCompatible?: boolean
  fwVersion?: string
  chip?: string
  hid?: unknown
  touchRoute?: 'local_ui' | 'usb_touchpad'
  capacity?: DeviceCapacity
  lastError?: string
  capabilities?: string[]
}

export interface DeviceRpcRequest {
  deviceId: string
  command: number
  payload?: unknown
}

export interface DeviceFileRequest {
  deviceId: string
  plugin: string
  path: string
}

export interface DeviceWriteFile {
  path: string
  data: string | number[]
}

export interface DeviceWriteFileRequest {
  deviceId: string
  plugin: string
  path?: string
  data?: string | number[]
  files?: DeviceWriteFile[]
  generation?: number
  run?: boolean
}

export interface DeviceReadFileResult {
  text?: string
  bytes?: number[]
  encoding: 'utf8' | 'binary' | 'image'
}

export interface DeviceLogEvent {
  deviceId: string
  line: string
}

export interface DeviceProgressEvent {
  deviceId: string
  plugin?: string
  path?: string
  phase: string
  offset?: number
  total?: number
  percent?: number
  message?: string
}

export interface DevicePluginRow {
  id: string
  native?: boolean
  kind?: string
  readonly?: boolean
  running?: boolean
  version?: number
  prev_version?: number
  generation?: number
  name?: string
  enable?: boolean
}

export interface DeviceApi {
  list(): Promise<DeviceInfo[]>
  connect(id: string): Promise<DeviceInfo>
  disconnect(id: string): Promise<void>
  abort(deviceId: string): Promise<void>
  pluginList(deviceId: string): Promise<DevicePluginRow[]>
  fileList(
    deviceId: string,
    plugin: string,
    path?: string,
    recursive?: boolean
  ): Promise<unknown>
  mkdir(deviceId: string, plugin: string, path: string, generation: number): Promise<void>
  rename(
    deviceId: string,
    plugin: string,
    from: string,
    to: string,
    generation: number
  ): Promise<void>
  deletePath(deviceId: string, plugin: string, path: string, generation: number): Promise<void>
  capacity(deviceId: string): Promise<DeviceCapacity>
  readFile(req: DeviceFileRequest): Promise<DeviceReadFileResult>
  writeFile(req: DeviceWriteFileRequest): Promise<{ generation?: number }>
  saveAndRun(req: DeviceWriteFileRequest): Promise<{ generation?: number }>
  setTouchRoute(deviceId: string, route: 'local_ui' | 'usb_touchpad'): Promise<void>
  onChanged(cb: (devices: DeviceInfo[]) => void): () => void
  onLog(cb: (event: DeviceLogEvent) => void): () => void
  onProgress(cb: (event: DeviceProgressEvent) => void): () => void
}
