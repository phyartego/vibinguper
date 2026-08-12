/**
 * BLE 悬浮窗协议业务逻辑（主进程专用）——
 * 把 AgentSessionProjection[] 归约为 §3.1 的 items JSON 快照。
 *
 * 这里实现 §5（状态码映射）与 §6（排序 + focus 选取）。纯函数 + 显式状态入参，
 * 不触碰 Electron / IO，便于单测。projection 权威由 AgentSessionRuntime 持有；
 * 本模块只读取快照、不写回。
 */

import type { AgentSessionProjection, AgentSessionStatus } from '../../shared/agent-events'
import {
  BLE_STATUS_CODE,
  type BleSessionDataWire,
  type BleSessionItemWire
} from '../../shared/ble-float'

/** §6 排序优先级：needs-you 最优先，其次 working，再 error，其余并列。 */
const STATUS_SORT_RANK: Record<AgentSessionStatus, number> = {
  'needs-you': 0,
  working: 1,
  error: 2,
  idle: 3,
  done: 3,
  exited: 3
}

/**
 * 会被「需要用户关注」视作 focus 候选的状态集合。
 * - needs-you：待审批/待输入（最强提示）
 * - working / error：刚起/刚错
 * - done：本轮刚完成，用户可能要回看
 * idle/exited 不主动抢占焦点（exited 的退出事实已由排序下沉）。
 */
const FOCUS_CANDIDATE_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  'needs-you',
  'working',
  'error',
  'done'
])

/** §3.1：短 id ≤ 8 字符。UUID 去横线取前 8 位（冲突概率 ~1/2^32，可忽略）。 */
export function shortIdOf(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8).toLowerCase()
}

export interface ShortIdMapEntry {
  sessionId: string
  terminalId: string
}

function clampU8(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  if (value > 255) return 255
  return Math.floor(value)
}

/**
 * 由当前活动 projection 快照构建一条 §3.1 SessionData。
 *
 * @param projections   AgentSessionRuntime.listActive() 的当前快照
 * @param seq           应用层消息序号（uint16，单调）。调用方负责自增。
 * @param previousStatus 上一轮各 session 的状态（用于判定「本轮状态刚改变」）；
 *                      首次推送传空 Map，视作全部改变。
 * @param shortIdMap    输出参数：本轮构建的 短id→session 映射，供 FocusCmd 回查。
 *                      会先 clear 再填充。
 */
export function buildSessionData(
  projections: readonly AgentSessionProjection[],
  seq: number,
  previousStatus: ReadonlyMap<string, AgentSessionStatus>,
  shortIdMap: Map<string, ShortIdMapEntry>
): BleSessionDataWire {
  // 刷新短 id 映射（每轮重建，确保过期 session 不残留）。
  shortIdMap.clear()
  for (const projection of projections) {
    shortIdMap.set(shortIdOf(projection.sessionId), {
      sessionId: projection.sessionId,
      terminalId: projection.terminalId
    })
  }

  // §6 排序：状态优先级，组内按最近活动时间倒序。
  const sorted = [...projections].sort((left, right) => {
    const rankDelta = STATUS_SORT_RANK[left.status] - STATUS_SORT_RANK[right.status]
    if (rankDelta !== 0) return rankDelta
    return right.lastActivityAt - left.lastActivityAt
  })

  // §6 focus：在「本轮状态刚改变」且属于关注候选的 session 中，选优先级最高（组内最新）。
  let focusShortId: string | null = null
  let focusRank = Infinity
  let focusLa = -1
  for (const projection of sorted) {
    const previous = previousStatus.get(projection.sessionId)
    const changed = previous === undefined || previous !== projection.status
    if (!changed) continue
    if (!FOCUS_CANDIDATE_STATUSES.has(projection.status)) continue
    const rank = STATUS_SORT_RANK[projection.status]
    if (rank < focusRank || (rank === focusRank && projection.lastActivityAt > focusLa)) {
      focusShortId = shortIdOf(projection.sessionId)
      focusRank = rank
      focusLa = projection.lastActivityAt
    }
  }

  const items: BleSessionItemWire[] = sorted.map((projection) => ({
    id: shortIdOf(projection.sessionId),
    name: (projection.name ?? projection.adapterId ?? 'session').slice(0, 16),
    s: BLE_STATUS_CODE[projection.status],
    a: clampU8(projection.pendingAttentionCount),
    tc: clampU8(projection.activeToolCount),
    la: Math.floor(projection.lastActivityAt / 1000)
  }))

  // 无关注候选时，focus 取排序后的第一项（保持设备跟随最优先会话）。
  const focus = focusShortId ?? items[0]?.id ?? ''

  // §6：focus 项应排在 items[0]。
  if (focus) {
    const focusIndex = items.findIndex((item) => item.id === focus)
    if (focusIndex > 0) {
      const [focusItem] = items.splice(focusIndex, 1)
      items.unshift(focusItem)
    }
  }

  return { seq: seq & 0xffff, focus, items }
}
