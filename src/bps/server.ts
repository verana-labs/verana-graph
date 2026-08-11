import { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { BlockCommit, IngestOrchestrator } from '../ingest/orchestrator'
import { Logger } from '../util/logger'

// TG-BPS-1..7: anonymous, forward-only broadcast of lastAppliedBlock. No parameters, no replay,
// one notification per durable commit, slow clients disconnected rather than buffered.
export function attachBlockProgressServer(
  httpServer: Server,
  orchestrator: IngestOrchestrator,
  maxBufferedBytes: number,
  log: Logger,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/v4/graph/blocks/subscribe' })
  let last: BlockCommit | null = null

  orchestrator.events.on('commit', commit => {
    last = commit
    const payload = JSON.stringify({ type: 'block', block: commit.block, blockTime: commit.blockTime })
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      // TG-BPS-6: a slow client must not block the broadcast pipeline
      if (client.bufferedAmount > maxBufferedBytes) {
        log.warn('disconnecting slow block-progress client')
        client.terminate()
        continue
      }
      client.send(payload)
    }
  })

  wss.on('connection', ws => {
    const state = orchestrator.currentState
    ws.send(
      JSON.stringify({
        type: 'ready',
        block: last?.block ?? state.lastAppliedBlock,
        blockTime: last?.blockTime ?? new Date(0).toISOString(),
        blockIntervalMs: state.blockIntervalMs,
      }),
    )
    // TG-BPS-4: the channel is server-to-client only; client payloads are ignored
    ws.on('message', () => {})
    ws.on('error', () => ws.terminate())
  })

  return wss
}
