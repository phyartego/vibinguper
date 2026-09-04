import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Cpu,
  Download,
  FileCode2,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Upload,
  Usb,
  X
} from 'lucide-react'
import type {
  DeviceInfo,
  DevicePluginRow,
  DeviceProgressEvent
} from '../../shared/device-ipc'
import { VB_CDC_ERR } from '../../shared/cdc-file-protocol'
import {
  classifyFile,
  fileExtension,
  imageMime,
  isBinaryPlaceholder,
  isExamplesPlugin,
  isNativePlugin,
  nestFilePaths,
  parseDeviceError,
  type FileKind,
  type FileListItem,
  type FileTreeNode
} from '../../shared/plugin-files'
import { setDevicePluginsDirtyCheck } from './leave-guard'

type DirtyFile = {
  path: string
  kind: FileKind
  text?: string
  bytes?: number[]
}

type OpenState = {
  path: string
  kind: FileKind
  text: string
  bytes?: number[]
}

type PromptMode = 'mkdir' | 'create' | 'rename' | null

function formatKiB(n: number): string {
  return `${(n / 1024).toFixed(0)} KiB`
}

function flattenTree(nodes: FileTreeNode[], depth = 0): Array<FileTreeNode & { depth: number }> {
  const out: Array<FileTreeNode & { depth: number }> = []
  for (const node of nodes) {
    out.push({ ...node, depth })
    if (node.children?.length) out.push(...flattenTree(node.children, depth + 1))
  }
  return out
}

export default function DevicePluginsPage() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [plugins, setPlugins] = useState<DevicePluginRow[]>([])
  const [plugin, setPlugin] = useState('')
  const [tree, setTree] = useState<FileTreeNode[]>([])
  const [open, setOpen] = useState<OpenState | null>(null)
  const [dirty, setDirty] = useState<Record<string, DirtyFile>>({})
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [progress, setProgress] = useState<DeviceProgressEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<{ localGen: number; deviceGen?: number } | null>(null)
  const [prompt, setPrompt] = useState<{ mode: PromptMode; value: string; from?: string }>({
    mode: null,
    value: ''
  })
  const uploadRef = useRef<HTMLInputElement>(null)
  const saveRef = useRef<(run: boolean, generationOverride?: number) => Promise<void>>(
    async () => undefined
  )

  const device = devices.find((d) => d.id === deviceId)
  const pluginRow = plugins.find((p) => p.id === plugin)
  const native = isNativePlugin(pluginRow ?? (plugin ? { id: plugin } : undefined))
  const readonly = Boolean(pluginRow?.readonly) || isExamplesPlugin(plugin)
  const dirtyCount = Object.keys(dirty).length
  const hasDirty = dirtyCount > 0
  const generation = pluginRow?.generation ?? 0
  const currentKind = open ? classifyFile(open.path, open.bytes ? Uint8Array.from(open.bytes) : undefined) : null

  const confirmDiscard = useCallback((): boolean => {
    if (!hasDirty) return true
    return window.confirm('有未保存的修改，确定丢弃吗？')
  }, [hasDirty])

  useEffect(() => {
    setDevicePluginsDirtyCheck(() => hasDirty)
    return () => setDevicePluginsDirtyCheck(null)
  }, [hasDirty])

  useEffect(() => {
    const onBefore = (event: BeforeUnloadEvent): void => {
      if (!hasDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [hasDirty])

  const refresh = useCallback(async (): Promise<void> => {
    const list = await window.deviceApi.list()
    setDevices(list)
    if (!deviceId && list[0]) setDeviceId(list[0].id)
  }, [deviceId])

  useEffect(() => {
    void refresh()
    const offChanged = window.deviceApi.onChanged(setDevices)
    const offLog = window.deviceApi.onLog((event) => {
      setLogs((prev) => [...prev.slice(-80), event.line])
    })
    const offProgress = window.deviceApi.onProgress((event) => {
      setProgress(event)
    })
    return () => {
      offChanged()
      offLog()
      offProgress()
    }
  }, [refresh])

  const loadPlugins = useCallback(async (id: string): Promise<void> => {
    const list = (await window.deviceApi.pluginList(id)) as DevicePluginRow[]
    setPlugins(Array.isArray(list) ? list : [])
    try {
      const cap = await window.deviceApi.capacity(id)
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, capacity: cap } : d)))
    } catch {
      /* capacity optional after handshake */
    }
  }, [])

  const loadTree = useCallback(async (id: string, pluginId: string): Promise<void> => {
    const entries = (await window.deviceApi.fileList(id, pluginId, undefined, true)) as FileListItem[]
    setTree(nestFilePaths(Array.isArray(entries) ? entries : []))
  }, [])

  const connect = async (): Promise<void> => {
    if (!deviceId) return
    setError(null)
    try {
      await window.deviceApi.connect(deviceId)
      await loadPlugins(deviceId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const disconnect = async (): Promise<void> => {
    if (!deviceId) return
    if (!confirmDiscard()) return
    await window.deviceApi.disconnect(deviceId)
    setPlugins([])
    setPlugin('')
    setTree([])
    setOpen(null)
    setDirty({})
  }

  const selectDevice = (id: string): void => {
    if (id === deviceId) return
    if (!confirmDiscard()) return
    setDeviceId(id)
    setPlugin('')
    setTree([])
    setOpen(null)
    setDirty({})
    setError(null)
  }

  const openPlugin = async (id: string): Promise<void> => {
    if (!deviceId) return
    if (id !== plugin && !confirmDiscard()) return
    setPlugin(id)
    setOpen(null)
    setDirty({})
    setError(null)
    setConflict(null)
    const row = plugins.find((p) => p.id === id)
    if (isNativePlugin(row ?? { id })) {
      setTree([])
      return
    }
    try {
      await loadTree(deviceId, id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openFile = async (path: string): Promise<void> => {
    if (!deviceId || !plugin) return
    if (open && open.path !== path && dirty[open.path] && !window.confirm('当前文件有未保存修改，切换将保留在待提交列表。继续？')) {
      return
    }
    const cached = dirty[path]
    if (cached) {
      setOpen({
        path,
        kind: cached.kind,
        text: cached.text ?? '',
        bytes: cached.bytes
      })
      return
    }
    try {
      const file = await window.deviceApi.readFile({ deviceId, plugin, path })
      if (file.encoding === 'utf8' && file.text !== undefined) {
        setOpen({ path, kind: 'text', text: file.text })
      } else {
        setOpen({
          path,
          kind: file.encoding === 'image' ? 'image' : 'binary',
          text: '',
          bytes: file.bytes
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    if (open?.kind === 'image' && open.bytes) {
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(open.bytes)], { type: imageMime(open.path) })
      )
      setPreviewUrl(url)
      return () => URL.revokeObjectURL(url)
    }
    setPreviewUrl(null)
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.path, open?.kind, open?.bytes])

  const markTextDirty = (text: string): void => {
    if (!open) return
    setOpen({ ...open, text })
    setDirty((prev) => ({
      ...prev,
      [open.path]: { path: open.path, kind: 'text', text }
    }))
  }

  const collectDirtyFiles = (): { path: string; data: string | number[] }[] => {
    return Object.values(dirty).map((file) => {
      if (file.kind === 'text') return { path: file.path, data: file.text ?? '' }
      return { path: file.path, data: file.bytes ?? [] }
    })
  }

  const save = async (run: boolean, generationOverride?: number): Promise<void> => {
    if (!deviceId || !plugin) return
    if (native) {
      setError('固件内建插件不支持文件 RPC')
      return
    }
    if (readonly) {
      setError('examples 为只读，不能写入')
      return
    }
    const files = collectDirtyFiles()
    if (open?.kind === 'text' && open.path && !(open.path in dirty) && files.length === 0) {
      /* nothing changed */
    }
    if (files.length === 0) {
      setError('没有待保存的修改')
      return
    }
    for (const file of files) {
      if (typeof file.data === 'string') {
        if (isBinaryPlaceholder(file.data) || classifyFile(file.path) !== 'text') {
          setError('拒绝把二进制文件当作 UTF-8 文本保存')
          return
        }
      }
    }
    const snapshot = open
    setError(null)
    setBusy(true)
    setProgress({ deviceId, plugin, phase: 'start', percent: 0 })
    try {
      const result = await window.deviceApi.writeFile({
        deviceId,
        plugin,
        files,
        generation: generationOverride ?? generation,
        run
      })
      setDirty({})
      setConflict(null)
      if (typeof result?.generation === 'number') {
        setPlugins((prev) =>
          prev.map((p) => (p.id === plugin ? { ...p, generation: result.generation } : p))
        )
      }
      await loadPlugins(deviceId)
      await loadTree(deviceId, plugin)
      if (snapshot) await openFile(snapshot.path)
    } catch (e) {
      if (snapshot) setOpen(snapshot)
      const parsed = parseDeviceError(e)
      if (parsed.err === VB_CDC_ERR.CONFLICT_GEN) {
        let deviceGen: number | undefined
        try {
          const list = (await window.deviceApi.pluginList(deviceId)) as DevicePluginRow[]
          deviceGen = list.find((p) => p.id === plugin)?.generation
          setPlugins(list)
        } catch {
          /* keep local */
        }
        setConflict({ localGen: generationOverride ?? generation, deviceGen })
        setError(
          `generation 冲突：本地 ${generationOverride ?? generation}，设备 ${deviceGen ?? '未知'}。可重新加载丢弃本地，或确认后用最新 generation 覆盖设备内容。`
        )
      } else if (parsed.err === VB_CDC_ERR.VM_START_FAILED) {
        setError(`启动失败，设备已回滚。编辑器内容已保留：${parsed.message}`)
      } else {
        setError(parsed.message)
      }
    } finally {
      setBusy(false)
    }
  }

  saveRef.current = save

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        void saveRef.current(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const cancelTxn = async (): Promise<void> => {
    if (!deviceId) return
    await window.deviceApi.abort(deviceId)
    setBusy(false)
    setProgress(null)
  }

  const applyPrompt = async (): Promise<void> => {
    if (!deviceId || !plugin || !prompt.mode) return
    const name = prompt.value.trim().replace(/\\/g, '/')
    if (!name) return
    setError(null)
    try {
      if (prompt.mode === 'mkdir') {
        await window.deviceApi.mkdir(deviceId, plugin, name, generation)
      } else if (prompt.mode === 'rename' && prompt.from) {
        await window.deviceApi.rename(deviceId, plugin, prompt.from, name, generation)
        setDirty((prev) => {
          const next = { ...prev }
          if (next[prompt.from!]) {
            next[name] = { ...next[prompt.from!], path: name }
            delete next[prompt.from!]
          }
          return next
        })
      } else if (prompt.mode === 'create') {
        if (classifyFile(name) !== 'text') {
          setError('只能新建文本文件（py/json/md/txt/html/css/js/svg）')
          return
        }
        setDirty((prev) => ({
          ...prev,
          [name]: { path: name, kind: 'text', text: '' }
        }))
        setOpen({ path: name, kind: 'text', text: '' })
        setTree((prev) => nestFilePaths([
          ...flattenTree(prev).map(({ depth: _d, children: _c, ...e }) => e),
          { name: name.split('/').pop() ?? name, path: name, type: 'file', size: 0 }
        ]))
        setPrompt({ mode: null, value: '' })
        return
      }
      await loadTree(deviceId, plugin)
      setPrompt({ mode: null, value: '' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const deleteCurrent = async (path: string): Promise<void> => {
    if (!deviceId || !plugin) return
    if (!window.confirm(`删除 ${path}？`)) return
    try {
      await window.deviceApi.deletePath(deviceId, plugin, path, generation)
      setDirty((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      if (open?.path === path) setOpen(null)
      await loadTree(deviceId, plugin)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const downloadBytes = (path: string, bytes: number[]): void => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: imageMime(path) }))
    const a = document.createElement('a')
    a.href = url
    a.download = path.split('/').pop() ?? path
    a.click()
    URL.revokeObjectURL(url)
  }

  const onUpload = async (file: File): Promise<void> => {
    if (!open || !deviceId || !plugin) return
    const buf = new Uint8Array(await file.arrayBuffer())
    const bytes = [...buf]
    const kind = classifyFile(open.path, buf)
    if (kind === 'text') {
      setError('请用编辑器修改文本文件，不要用二进制上传覆盖')
      return
    }
    setOpen({ path: open.path, kind, text: '', bytes })
    setDirty((prev) => ({
      ...prev,
      [open.path]: { path: open.path, kind, bytes }
    }))
  }

  const visible = useMemo(() => flattenTree(tree), [tree])
  const progressPercent = progress?.percent ?? (busy ? 10 : 0)

  return (
    <div className="relative flex h-full min-h-0 bg-content text-text-primary" data-testid="device-plugins">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-maple text-xs text-text-muted">Vibing USB</span>
          <button type="button" onClick={() => void refresh()} className="rounded p-1 hover:bg-surface-hover">
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        {devices.length === 0 && (
          <p className="text-xs text-text-faint">未发现 VID 303A / PID 1001 候选</p>
        )}
        {devices.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => selectDevice(d.id)}
            className={`mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${
              deviceId === d.id ? 'bg-surface-strong' : 'hover:bg-surface-hover'
            }`}
          >
            <Usb className="size-3.5" />
            <span className="truncate">{d.serial}</span>
            {d.connected ? <span className="text-status-done">●</span> : null}
          </button>
        ))}
        <div className="mt-2 flex gap-1">
          <button
            type="button"
            onClick={() => void connect()}
            className="flex-1 rounded-lg bg-surface-strong px-2 py-1 text-xs"
          >
            连接
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="rounded-lg px-2 py-1 text-xs hover:bg-surface-hover"
          >
            断开
          </button>
        </div>
        <div className="mt-3 space-y-1 font-maple text-[10px] text-text-faint" data-testid="device-status">
          <div>连接：{device?.connected ? '已连接' : '未连接'}</div>
          <div>
            协议：
            {device?.protoCompatible
              ? `兼容 v${device.proto ?? 1}`
              : device?.connected
                ? '未知'
                : device?.lastError
                  ? '不兼容'
                  : '未握手'}
          </div>
          <div>
            存储：
            {device?.capacity
              ? `${formatKiB(device.capacity.used)} / ${formatKiB(device.capacity.total)}（剩余 ${formatKiB(device.capacity.free)}）`
              : '—'}
          </div>
          <div>固件：{device?.fwVersion ?? '—'}</div>
          <div>运行：{pluginRow?.running ? '是' : '否'}</div>
          <div className="truncate text-status-error">错误：{error ?? device?.lastError ?? '无'}</div>
        </div>
        <div className="mt-4 text-xs text-text-muted">插件</div>
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {plugins.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void openPlugin(p.id)}
              className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs ${
                plugin === p.id ? 'bg-surface-strong' : 'hover:bg-surface-hover'
              }`}
            >
              <Cpu className="size-3.5" />
              <span className="truncate">{p.id}</span>
              {p.native ? <span className="text-text-faint">固件</span> : null}
              {isExamplesPlugin(p.id) ? <span className="text-text-faint">只读</span> : null}
              {p.running ? <span className="text-status-done">●</span> : null}
            </button>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs">
          <span className="text-text-muted">
            {plugin || '—'}{open ? `/${open.path}` : ''}
            {hasDirty ? ` *${dirtyCount}` : ''}
          </span>
          {readonly ? (
            <span className="rounded bg-surface-strong px-1.5 py-0.5 text-[10px] text-text-faint">只读</span>
          ) : null}
          {native ? (
            <span className="rounded bg-surface-strong px-1.5 py-0.5 text-[10px] text-text-faint">固件内建</span>
          ) : null}
          {!native && !readonly && (
            <>
              <button
                type="button"
                data-testid="device-save"
                disabled={busy}
                onClick={() => void save(false)}
                className="ml-auto flex items-center gap-1 rounded-lg bg-surface-strong px-2 py-1"
              >
                <Save className="size-3.5" /> 保存
              </button>
              <button
                type="button"
                data-testid="device-save-run"
                disabled={busy}
                onClick={() => void save(true)}
                className="flex items-center gap-1 rounded-lg bg-surface-strong px-2 py-1"
              >
                <Save className="size-3.5" /> 保存并运行
              </button>
            </>
          )}
          {(native || readonly) && <span className="ml-auto" />}
          <select
            value={device?.touchRoute ?? 'local_ui'}
            onChange={(e) => {
              const next = e.target.value as 'local_ui' | 'usb_touchpad'
              if (deviceId) void window.deviceApi.setTouchRoute(deviceId, next)
            }}
            className="rounded bg-surface-strong px-1 py-1"
          >
            <option value="local_ui">local_ui</option>
            <option value="usb_touchpad">usb_touchpad</option>
          </select>
        </div>
        {(busy || progress) && (
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1 text-[10px]" data-testid="device-progress">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-surface-strong">
              <div
                className="h-full bg-status-working"
                style={{ width: `${Math.min(100, progressPercent)}%` }}
              />
            </div>
            <span className="text-text-faint">{progress?.phase ?? ''} {progress?.path ?? ''}</span>
            <button type="button" onClick={() => void cancelTxn()} className="flex items-center gap-1 rounded px-1 hover:bg-surface-hover">
              <Square className="size-3" /> 取消
            </button>
          </div>
        )}
        {native ? (
          <div className="flex flex-1 items-center justify-center text-xs text-text-faint">
            固件内建插件，无文件 RPC
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-52 shrink-0 flex-col border-r border-border-subtle text-xs" data-testid="file-tree">
              {!readonly && (
                <div className="flex gap-1 border-b border-border-subtle p-1">
                  <button type="button" title="新建目录" onClick={() => setPrompt({ mode: 'mkdir', value: '' })} className="rounded p-1 hover:bg-surface-hover">
                    <FolderPlus className="size-3.5" />
                  </button>
                  <button type="button" title="新建文本文件" onClick={() => setPrompt({ mode: 'create', value: '' })} className="rounded p-1 hover:bg-surface-hover">
                    <Plus className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="重命名"
                    disabled={!open}
                    onClick={() => open && setPrompt({ mode: 'rename', value: open.path, from: open.path })}
                    className="rounded p-1 hover:bg-surface-hover disabled:opacity-40"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    title="删除"
                    disabled={!open}
                    onClick={() => open && void deleteCurrent(open.path)}
                    className="rounded p-1 hover:bg-surface-hover disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              )}
              {prompt.mode && (
                <div className="flex gap-1 border-b border-border-subtle p-1">
                  <input
                    value={prompt.value}
                    onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
                    placeholder={prompt.mode === 'mkdir' ? '目录路径' : prompt.mode === 'rename' ? '新路径' : '文件路径'}
                    className="min-w-0 flex-1 rounded bg-surface-strong px-1 py-0.5 outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void applyPrompt()
                      if (e.key === 'Escape') setPrompt({ mode: null, value: '' })
                    }}
                  />
                  <button type="button" onClick={() => void applyPrompt()} className="rounded px-1 hover:bg-surface-hover">OK</button>
                  <button type="button" onClick={() => setPrompt({ mode: null, value: '' })} className="rounded px-1 hover:bg-surface-hover">
                    <X className="size-3" />
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {visible.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => {
                      if (f.type === 'dir') return
                      void openFile(f.path)
                    }}
                    style={{ paddingLeft: 4 + f.depth * 10 }}
                    className={`mb-0.5 flex w-full items-center gap-1 truncate rounded py-0.5 text-left hover:bg-surface-hover ${
                      open?.path === f.path ? 'bg-surface-strong' : ''
                    }`}
                  >
                    {f.type === 'dir' ? <Folder className="size-3 shrink-0" /> : fileExtension(f.path) && classifyFile(f.path) === 'image' ? <ImageIcon className="size-3 shrink-0" /> : <FileCode2 className="size-3 shrink-0" />}
                    <span className="truncate">{f.name}{dirty[f.path] ? ' *' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {currentKind === 'text' && open && (
                <textarea
                  value={open.text}
                  readOnly={readonly}
                  onChange={(e) => markTextDirty(e.target.value)}
                  className="min-h-0 min-w-0 flex-1 resize-none bg-transparent p-3 font-maple text-xs outline-none"
                  spellCheck={false}
                  data-testid="device-editor"
                />
              )}
              {currentKind === 'image' && open && (
                <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-auto p-4" data-testid="image-preview">
                  {previewUrl ? (
                    <img src={previewUrl} alt={open.path} className="max-h-[70%] max-w-full object-contain" />
                  ) : (
                    <span className="text-xs text-text-faint">无预览</span>
                  )}
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => open.bytes && downloadBytes(open.path, open.bytes)}
                      className="flex items-center gap-1 rounded-lg bg-surface-strong px-2 py-1"
                    >
                      <Download className="size-3.5" /> 下载
                    </button>
                    {!readonly && (
                      <button
                        type="button"
                        onClick={() => uploadRef.current?.click()}
                        className="flex items-center gap-1 rounded-lg bg-surface-strong px-2 py-1"
                      >
                        <Upload className="size-3.5" /> 上传替换
                      </button>
                    )}
                  </div>
                </div>
              )}
              {currentKind === 'binary' && open && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-text-muted" data-testid="binary-preview">
                  <p>二进制文件 {open.bytes?.length ?? 0} 字节，不可当文本编辑。</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => open.bytes && downloadBytes(open.path, open.bytes)}
                      className="flex items-center gap-1 rounded-lg bg-surface-strong px-2 py-1"
                    >
                      <Download className="size-3.5" /> 下载
                    </button>
                    {!readonly && (
                      <button
                        type="button"
                        onClick={() => uploadRef.current?.click()}
                        className="flex items-center gap-1 rounded-lg bg-surface-strong px-2 py-1"
                      >
                        <Upload className="size-3.5" /> 上传替换
                      </button>
                    )}
                  </div>
                </div>
              )}
              {!open && (
                <div className="flex flex-1 items-center justify-center text-xs text-text-faint">
                  选择一个文件
                </div>
              )}
              <input
                ref={uploadRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void onUpload(file)
                  e.target.value = ''
                }}
              />
            </div>
            <div className="flex w-44 shrink-0 flex-col border-l border-border-subtle p-2 text-[10px] text-text-faint">
              <div className="mb-1 text-text-muted">设备日志</div>
              <div className="min-h-0 flex-1 overflow-y-auto font-maple" data-testid="device-log">
                {logs.map((line, i) => (
                  <div key={`${i}-${line.slice(0, 12)}`} className="truncate">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="border-t border-border-subtle px-3 py-2 text-xs text-status-error" data-testid="device-error">
            {error}
          </div>
        )}
      </section>
      {conflict && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-backdrop-strong" data-testid="conflict-dialog">
          <div className="w-[380px] rounded-2xl border border-border-default bg-surface p-4 shadow-2xl">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 text-status-error" />
              generation 冲突
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">
              本地 generation 为 {conflict.localGen}，设备当前为 {conflict.deviceGen ?? '未知'}。
              「重新加载」会丢弃本地未保存修改并从设备读回。
              「覆盖设备」会先取设备最新 generation，再用本地内容提交（不会用过期 generation）。
            </p>
            <div className="mt-4 flex justify-end gap-2 text-xs">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 hover:bg-surface-strong"
                onClick={() => setConflict(null)}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="conflict-reload"
                className="rounded-lg bg-surface-strong px-3 py-1.5"
                onClick={async () => {
                  setDirty({})
                  setConflict(null)
                  if (deviceId && plugin) {
                    await loadPlugins(deviceId)
                    await loadTree(deviceId, plugin)
                    if (open) await openFile(open.path)
                  }
                }}
              >
                重新加载
              </button>
              <button
                type="button"
                data-testid="conflict-overwrite"
                className="rounded-lg bg-status-error px-3 py-1.5 text-white"
                onClick={async () => {
                  let deviceGen = conflict.deviceGen
                  if (deviceId) {
                    const list = (await window.deviceApi.pluginList(deviceId)) as DevicePluginRow[]
                    deviceGen = list.find((p) => p.id === plugin)?.generation ?? deviceGen
                    setPlugins(list)
                  }
                  setConflict(null)
                  if (deviceGen === undefined) {
                    setError('无法读取设备 generation，拒绝覆盖')
                    return
                  }
                  await save(false, deviceGen)
                }}
              >
                覆盖设备
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
