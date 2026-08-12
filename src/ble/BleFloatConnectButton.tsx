/**
 * BleFloatConnectButton —— 「连接 Vibing-Float 硬件屏」入口。
 *
 * Web Bluetooth 的 requestDevice 必须由用户手势触发，故用一个真实按钮承载 connect。
 * 按钮挂在主窗口 AppShell 右下角（fixed），不侵入既有布局。状态色对齐契约 §5：
 * connected=绿、connecting=蓝、error=红、idle=灰、unsupported=隐藏。
 */

import { useBleFloat } from './useBleFloat'

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-surface-hover text-text-secondary',
  connecting: 'bg-status-working/20 text-status-working',
  connected: 'bg-status-done/20 text-status-done',
  disconnected: 'bg-surface-hover text-text-secondary',
  error: 'bg-status-error/20 text-status-error',
  unsupported: 'bg-surface-hover text-text-faint'
}

const STATUS_LABEL: Record<string, string> = {
  idle: '连接 Vibing-Float',
  connecting: '连接中…',
  connected: 'Vibing-Float 已连接',
  disconnected: '已断开 · 重连',
  error: '连接失败 · 重试',
  unsupported: 'Web Bluetooth 不可用'
}

export default function BleFloatConnectButton() {
  const { state, connect, disconnect } = useBleFloat()

  if (state.status === 'unsupported') {
    return <></>
  }

  const handleClick = (): void => {
    if (state.status === 'connected') {
      disconnect()
    } else {
      void connect()
    }
  }

  return (
    <button
      type="button"
      data-testid="ble-float-connect"
      onClick={handleClick}
      className={`fixed bottom-3 right-3 z-50 rounded-full px-3 py-1.5 text-[11px] font-medium shadow-md transition-colors hover:opacity-90 ${STATUS_COLOR[state.status]}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`size-1.5 rounded-full ${
            state.status === 'connected'
              ? 'bg-status-done'
              : state.status === 'connecting'
                ? 'animate-pulse bg-status-working'
                : state.status === 'error'
                  ? 'bg-status-error'
                  : 'bg-text-faint'
          }`}
        />
        {STATUS_LABEL[state.status]}
      </span>
    </button>
  )
}
