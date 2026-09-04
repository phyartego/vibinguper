/**
 * Plugin workspace helpers shared by DeviceManager and the renderer.
 * Text vs binary classification, tree nesting, and write guards.
 */

export const TEXT_EXTS = new Set([
  'py',
  'json',
  'md',
  'txt',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'svg',
  'csv',
  'toml',
  'ini',
  'yml',
  'yaml',
  'xml',
  'map'
])

export const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico'
])

export type FileKind = 'text' | 'image' | 'binary'

export type FileListItem = {
  name: string
  type: 'file' | 'dir'
  size: number
  sha256?: string
  path?: string
}

export type FileTreeNode = FileListItem & {
  path: string
  children?: FileTreeNode[]
}

export type PluginKindHint = {
  id: string
  native?: boolean
  kind?: string
  readonly?: boolean
}

export function fileExtension(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function isBinaryPlaceholder(text: string): boolean {
  return /^\s*\[binary \d+ bytes\]\s*$/.test(text)
}

export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

export function classifyFile(path: string, bytes?: Uint8Array): FileKind {
  const ext = fileExtension(path)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) {
    if (bytes && !looksLikeUtf8Text(bytes)) return 'binary'
    return 'text'
  }
  if (bytes) return looksLikeUtf8Text(bytes) ? 'text' : 'binary'
  return 'binary'
}

export function imageMime(path: string): string {
  switch (fileExtension(path)) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

export function assertCanSaveAsText(path: string, data: string): void {
  if (isBinaryPlaceholder(data) || data.includes('\0')) {
    throw new Error('refusing to save binary file as UTF-8 text')
  }
  if (classifyFile(path) !== 'text') {
    throw new Error('refusing to save binary file as UTF-8 text')
  }
}

export function isSystemPlugin(id: string): boolean {
  return id === 'system' || id.startsWith('system/')
}

export function isExamplesPlugin(id: string): boolean {
  return id === 'examples' || id.startsWith('examples/')
}

export const NATIVE_PLUGIN_IDS = new Set([
  'session_card',
  'clock',
  'sysmon',
  'status_bar'
])

export function isNativePlugin(row: PluginKindHint | undefined): boolean {
  if (!row) return false
  return row.native === true || row.kind === 'native' || NATIVE_PLUGIN_IDS.has(row.id)
}

export function isReadonlyPlugin(row: PluginKindHint | undefined): boolean {
  if (!row) return false
  return row.readonly === true || isExamplesPlugin(row.id)
}

export function normalizeFileEntry(raw: unknown): FileListItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name : typeof o.path === 'string' ? o.path.split('/').pop() ?? o.path : ''
  if (!name) return null
  const type = o.type === 'dir' || o.type === 'directory' || o.kind === 'dir' ? 'dir' : 'file'
  const size = typeof o.size === 'number' ? o.size : 0
  const sha256 = typeof o.sha256 === 'string' ? o.sha256 : undefined
  const path = typeof o.path === 'string' ? o.path : undefined
  return { name, type, size, sha256, path }
}

export function parseFileListResponse(raw: unknown): {
  entries: FileListItem[]
  cursor?: string
  complete: boolean
} {
  if (Array.isArray(raw)) {
    return {
      entries: raw.map(normalizeFileEntry).filter((e): e is FileListItem => e !== null),
      complete: true
    }
  }
  if (!raw || typeof raw !== 'object') {
    return { entries: [], complete: true }
  }
  const o = raw as Record<string, unknown>
  const list = o.entries ?? o.items ?? o.files ?? o.list
  const entries = Array.isArray(list)
    ? list.map(normalizeFileEntry).filter((e): e is FileListItem => e !== null)
    : []
  const cursor =
    typeof o.cursor === 'string' && o.cursor
      ? o.cursor
      : typeof o.next === 'string' && o.next
        ? o.next
        : undefined
  const complete = o.done === true || o.complete === true || !cursor
  return { entries, cursor: complete ? undefined : cursor, complete }
}

export function parsePluginListResponse(raw: unknown): PluginKindHint[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).plugins ??
          (raw as Record<string, unknown>).items ??
          (raw as Record<string, unknown>).list)
      : []
  if (!Array.isArray(list)) return []
  const out: PluginKindHint[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    out.push({
      id: o.id,
      native: o.native === true,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      readonly: o.readonly === true,
      ...o
    } as PluginKindHint)
  }
  return out.filter((p) => !isSystemPlugin(p.id))
}

export function nestFilePaths(entries: FileListItem[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const dirs = new Map<string, FileTreeNode>()

  const ensureDir = (path: string): FileTreeNode => {
    const existing = dirs.get(path)
    if (existing) return existing
    const name = path.split('/').pop() ?? path
    const node: FileTreeNode = { name, path, type: 'dir', size: 0, children: [] }
    dirs.set(path, node)
    const slash = path.lastIndexOf('/')
    if (slash >= 0) {
      ensureDir(path.slice(0, slash)).children!.push(node)
    } else {
      root.push(node)
    }
    return node
  }

  for (const entry of entries) {
    const path = entry.path || entry.name
    if (!path) continue
    const slash = path.lastIndexOf('/')
    const name = path.split('/').pop() ?? path
    if (entry.type === 'dir') {
      const node = ensureDir(path)
      node.size = entry.size
      node.sha256 = entry.sha256
      continue
    }
    const node: FileTreeNode = { ...entry, name, path }
    if (slash >= 0) {
      ensureDir(path.slice(0, slash)).children!.push(node)
    } else {
      root.push(node)
    }
  }
  return root
}

export function parseDeviceError(error: unknown): { err?: number; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^CDC_ERR (\d+): ([\s\S]*)$/.exec(message)
  if (match) {
    return { err: Number(match[1]), message: match[2] ?? message }
  }
  return { message }
}

export function saveFailureState<T extends { text: string }>(
  current: T,
  error: unknown
): T & { error: string; dirty: boolean } {
  const parsed = parseDeviceError(error)
  return {
    ...current,
    error: parsed.message,
    dirty: true
  }
}
