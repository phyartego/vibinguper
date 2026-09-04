import type {
  AgentApi
} from '../shared/agent-events'
import type {
  AppApi,
  AppThemeApi,
  CliApi,
  ClipboardApi,
  DialogApi,
  FloatingWindowApi,
  PtyApi,
  ShellApi,
  StatsApi,
  ThemeApi,
  WindowApi
} from '../shared/ipc-contract'
import type { BleFloatApi } from '../shared/ble-float'
import type { VibingDebugShellApi } from './app/AppShell'
import type { WorkspaceReaderApi } from '../shared/workspace-reader'
import type { DeviceApi } from '../shared/device-ipc'

// renderer 全局类型：preload 通过 contextBridge 注入 window.ptyApi。
declare global {
  interface Window {
    ptyApi: PtyApi
    clipboardApi: ClipboardApi
    windowApi: WindowApi
    floatingWindowApi: FloatingWindowApi
    themeApi: ThemeApi
    dialogApi: DialogApi
    shellApi: ShellApi
    cliApi: CliApi
    statsApi: StatsApi
    agentApi: AgentApi
    workspaceReader: WorkspaceReaderApi
    appApi: AppApi
    appThemeApi: AppThemeApi
    bleFloatApi: BleFloatApi
    deviceApi: DeviceApi
    __VIBING_E2E__?: true
    __vibingDebugShell?: VibingDebugShellApi
  }
}

export {}
