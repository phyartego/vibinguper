import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentSessionProjection } from '../../shared/agent-events'

export const DISPLAY_PREVIEW_BRIDGE_PORT = 4175

export interface DisplayPreviewSession {
  id: string
  name: string
  adapterId: string
  status: AgentSessionProjection['status']
  detail: string
  lastActivityAt: number
  pendingAttentionCount: number
  activeToolCount: number
}

interface DisplayPreviewBridgeDeps {
  listActive(): readonly AgentSessionProjection[]
  focusSession(sessionId: string): boolean
}

/** Localhost-only bridge for display-preview.html. */
export class DisplayPreviewBridge {
  private server: Server | null = null

  constructor(private readonly deps: DisplayPreviewBridgeDeps) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(DISPLAY_PREVIEW_BRIDGE_PORT, '127.0.0.1')
    })
    console.log('[display-preview] bridge ready at http://127.0.0.1:' + DISPLAY_PREVIEW_BRIDGE_PORT)
  }

  dispose(): void {
    const server = this.server
    this.server = null
    server?.close()
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    this.setCorsHeaders(response)
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }

    const url = new URL(
      request.url ?? '/',
      'http://127.0.0.1:' + DISPLAY_PREVIEW_BRIDGE_PORT
    )
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const sessions = [...this.deps.listActive()]
        .filter((session) => session.status !== 'exited')
        .sort(
          (left, right) =>
            right.lastActivityAt - left.lastActivityAt ||
            left.sessionId.localeCompare(right.sessionId)
        )
        .map((session): DisplayPreviewSession => ({
          id: session.sessionId,
          name: session.name ?? session.adapterId,
          adapterId: session.adapterId,
          status: session.status,
          detail: session.detail ?? '',
          lastActivityAt: session.lastActivityAt,
          pendingAttentionCount: session.pendingAttentionCount,
          activeToolCount: session.activeToolCount
        }))
      this.sendJson(response, 200, { now: Date.now(), sessions })
      return
    }

    const focusMatch =
      request.method === 'POST'
        ? /^\/api\/sessions\/([^/]+)\/focus$/.exec(url.pathname)
        : null
    if (focusMatch) {
      let sessionId: string
      try {
        sessionId = decodeURIComponent(focusMatch[1])
      } catch {
        this.sendJson(response, 400, { ok: false, error: 'invalid session id' })
        return
      }
      const focused = this.deps.focusSession(sessionId)
      this.sendJson(response, focused ? 200 : 404, { ok: focused })
      return
    }

    this.sendJson(response, 404, { error: 'not found' })
  }

  private setCorsHeaders(response: ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    response.setHeader('Cache-Control', 'no-store')
  }

  private sendJson(
    response: ServerResponse,
    status: number,
    body: unknown
  ): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
}
