import { WebSocket } from 'ws'
import { Logger } from '../util/logger'
import { BlockMessage, ReadyMessage, SubscribedMessage } from './types'

// TG-INGEST-1: all channels on, all opt-in sub-flags true, dids[] omitted (wildcard)
export const CANONICAL_SUBSCRIBE = {
  action: 'subscribe',
  channels: {
    trust: true,
    corporation: { includeDepositChanges: true },
    participations: {
      includeWeightChanges: true,
      includeParticipantCounts: true,
      includeIssuedCredentials: true,
      includeVerifiedCredentials: true,
    },
    ecsCredentials: true,
    presentations: true,
    services: true,
    ecosystems: {
      includeParticipantCounts: true,
      includeIssuedCredentials: true,
      includeVerifiedCredentials: true,
    },
  },
} as const

const MIN_LIVENESS_MS = 60_000

export interface SubscriptionHandlers {
  onReady: (msg: ReadyMessage) => void
  onSubscribed: (msg: SubscribedMessage) => void
  onBlock: (msg: BlockMessage) => void
  // fired on close, error, or liveness timeout; the orchestrator reconnects and runs gap recovery
  onDown: (reason: string) => void
}

// One connection per instance; the orchestrator creates a fresh one on every (re)connect so the
// bootstrap/recovery sequence around it stays explicit.
export class IndexerSubscription {
  private ws?: WebSocket
  private livenessTimer?: NodeJS.Timeout
  private ackTimer?: NodeJS.Timeout
  private blockIntervalMs = 6000
  private downFired = false

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: SubscriptionHandlers,
    private readonly log: Logger,
  ) {}

  connect(): void {
    const ws = new WebSocket(`${this.wsUrl}/v4/verifiable-trust/subscribe`)
    this.ws = ws
    ws.on('open', () => this.log.debug('indexer ws open'))
    ws.on('message', data => {
      let msg: ReadyMessage | SubscribedMessage | BlockMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        this.log.warn({ data: data.toString().slice(0, 200) }, 'unparseable indexer ws message')
        return
      }
      if (msg.type === 'ready') {
        this.blockIntervalMs = msg.blockIntervalMs
        this.resetLiveness()
        ws.send(JSON.stringify(CANONICAL_SUBSCRIBE))
        this.armAckTimeout()
        this.handlers.onReady(msg)
      } else if (msg.type === 'subscribed') {
        this.clearAckTimeout()
        this.resetLiveness()
        this.handlers.onSubscribed(msg)
      } else if (msg.type === 'block') {
        this.resetLiveness()
        this.handlers.onBlock(msg)
      }
      // unknown message types are ignored
    })
    ws.on('error', err => this.down(`error: ${err.message}`))
    ws.on('close', () => this.down('closed'))
  }

  // Block production is the documented heartbeat, so the spec's rule is 2x blockIntervalMs.
  // The reference indexer advertises blockIntervalMs=6000 but flushes blocks in batches ~16s
  // apart, which trips that rule on every quiet cycle and makes the subscription flap. Floor the
  // timeout so batched delivery is tolerated while a genuinely dead link is still caught.
  private resetLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    const timeout = Math.max(2 * this.blockIntervalMs, MIN_LIVENESS_MS)
    this.livenessTimer = setTimeout(() => {
      this.log.warn({ timeout }, 'indexer ws liveness timeout')
      this.ws?.terminate()
      this.down('liveness timeout')
    }, timeout)
  }

  private armAckTimeout(): void {
    this.clearAckTimeout()
    this.ackTimer = setTimeout(() => {
      this.log.warn('no subscribed acknowledgement, treating the subscription as not established')
      this.ws?.terminate()
      this.down('subscribed timeout')
    }, 2 * this.blockIntervalMs)
  }

  private clearAckTimeout(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = undefined
  }

  private down(reason: string): void {
    if (this.downFired) return
    this.downFired = true
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.clearAckTimeout()
    this.handlers.onDown(reason)
  }

  close(): void {
    this.downFired = true
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.clearAckTimeout()
    this.ws?.close()
  }
}
