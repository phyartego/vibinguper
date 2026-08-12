/**
 * useBleFloat —— 主窗口 renderer 内挂载的 Web Bluetooth central 生命周期钩子。
 *
 * 设计要点：
 * - central 实例用 useRef 持有，组件存活期间稳定（避免 StrictMode/dev 双 mount 重建连接）；
 * - 连接必须由真实 DOM 用户手势触发（Web Bluetooth requestDevice 要求），故暴露
 *   connect() 给按钮 onClick，不在 effect 里自动连；
 * - 卸载时主动 disconnect，避免 GATT 连接泄漏。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { WebBluetoothBleCentral, type BleCentralState } from './webBluetoothCentral'

export interface UseBleFloat {
  state: BleCentralState
  connect: () => Promise<void>
  disconnect: () => void
}

export function useBleFloat(): UseBleFloat {
  const centralRef = useRef<WebBluetoothBleCentral | null>(null)
  const [state, setState] = useState<BleCentralState>(() =>
    typeof navigator !== 'undefined' && navigator.bluetooth
      ? { status: 'idle' }
      : { status: 'unsupported' }
  )

  if (centralRef.current === null) {
    centralRef.current = new WebBluetoothBleCentral(window.bleFloatApi, setState)
  }

  const connect = useCallback(async (): Promise<void> => {
    await centralRef.current?.connect()
  }, [])

  const disconnect = useCallback((): void => {
    centralRef.current?.disconnect()
    setState((current) =>
      current.status === 'connected' || current.status === 'connecting'
        ? { status: 'disconnected' }
        : current
    )
  }, [])

  useEffect(() => {
    return () => {
      centralRef.current?.disconnect()
      centralRef.current = null
    }
  }, [])

  return { state, connect, disconnect }
}
