let dirtyCheck: (() => boolean) | null = null

export function setDevicePluginsDirtyCheck(fn: (() => boolean) | null): void {
  dirtyCheck = fn
}

export function confirmLeaveDevicePlugins(): boolean {
  if (!dirtyCheck?.()) return true
  return window.confirm('有未保存的修改，确定丢弃吗？')
}
