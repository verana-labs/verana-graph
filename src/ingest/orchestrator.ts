import { EventEmitter } from 'node:events'
import { Knex } from 'knex'
import { Dereferencer } from '../deref/deref'
import { IndexerRestClient } from '../indexer/rest'
import {
  BlockMessage,
  ChangeEnvelope,
  needsResolve,
  ReadyMessage,
  ResolveResponse,
  SubscribedMessage,
} from '../indexer/types'
import { IndexerSubscription } from '../indexer/ws'
import { Logger } from '../util/logger'
import { applyInlineTrust, reconcile, repairDerivedFacets } from './reconciler'

export interface BlockCommit {
  block: number
  blockTime: string
}

export interface OrchestratorEvents {
  emit(event: 'commit', payload: BlockCommit): boolean
  on(event: 'commit', listener: (payload: BlockCommit) => void): this
}

const BOOTSTRAP_CONCURRENCY = 8
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

export class IngestOrchestrator {
  readonly events: OrchestratorEvents = new EventEmitter()
  private subscription?: IndexerSubscription
  private buffer: BlockMessage[] = []
  private catchingUp = false
  private previousBlock = -1
  private lastAppliedBlock = -1
  private blockIntervalMs = 6000
  private generation = 0
  private readyBlockTime = new Date(0).toISOString()
  private reconnectAttempt = 0
  private stopped = false
  private refreshTimer?: NodeJS.Timeout

  constructor(
    private readonly db: Knex,
    private readonly rest: IndexerRestClient,
    private readonly deref: Dereferencer,
    private readonly wsUrl: string,
    private readonly log: Logger,
    private readonly refreshIntervalMs = 300_000,
    private readonly refreshBatch = 200,
  ) {}

  get currentState(): { lastAppliedBlock: number; blockIntervalMs: number } {
    return { lastAppliedBlock: this.lastAppliedBlock, blockIntervalMs: this.blockIntervalMs }
  }

  async start(): Promise<void> {
    const row = await this.db('ingestion_state')
      .where('id', 1)
      .first<{ last_applied_block: number; last_block_time: Date } | undefined>()
    if (row) {
      this.lastAppliedBlock = row.last_applied_block
      this.events.emit('commit', {
        block: row.last_applied_block,
        blockTime: row.last_block_time.toISOString(),
      })
    }
    this.connect()
    if (this.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refreshExpiredTrust().catch(err =>
          this.log.warn({ err: (err as Error).message }, 'trust refresh sweep failed'),
        )
      }, this.refreshIntervalMs)
      this.refreshTimer.unref()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.subscription?.close()
  }

  // Interim workaround, default off. spec v4-draft3 (IDX-VT-EVAL-2) makes expiresAtTime an
  // exact horizon needing no follower-side refresh, but an indexer still computing the old
  // fixed TTL empties the discovery surface on a quiet chain (observed live). Set
  // TRUST_REFRESH_INTERVAL_MS>0 only against such an indexer; remove once IDX-VT-EVAL-2/3 land.
  async refreshExpiredTrust(): Promise<number> {
    if (this.catchingUp || this.lastAppliedBlock < 0) return 0
    const rows = await this.db('dids')
      .where('expires_at_time', '<', new Date().toISOString())
      .orderBy('expires_at_time')
      .limit(this.refreshBatch)
      .select<{ did: string }[]>('did')
    if (rows.length === 0) return 0

    const block = this.lastAppliedBlock
    const evidence = { block, blockTime: new Date().toISOString() }
    let refreshed = 0
    for (const { did } of rows) {
      try {
        const response = await this.rest.resolve(did, block)
        await this.applyResponse(response, evidence)
        refreshed++
      } catch (err) {
        this.log.warn({ did, err: (err as Error).message }, 'trust refresh resolve failed')
      }
    }
    this.log.info({ refreshed, block }, 'trust refresh sweep complete')
    return refreshed
  }

  private connect(): void {
    if (this.stopped) return
    this.catchingUp = true
    this.buffer = []
    const generation = ++this.generation
    const stale = (): boolean => generation !== this.generation || this.stopped
    this.subscription = new IndexerSubscription(
      this.wsUrl,
      {
        onReady: msg => {
          if (stale()) return
          this.blockIntervalMs = msg.blockIntervalMs
          this.readyBlockTime = msg.blockTime
          this.reconnectAttempt = 0
        },
        onSubscribed: msg => {
          if (stale()) return
          this.previousBlock = msg.block - 1
          void this.catchUp(msg).catch(err => {
            if (stale()) return
            this.log.error({ err: (err as Error).message }, 'catch-up failed')
            this.subscription?.close()
            this.scheduleReconnect()
          })
        },
        onBlock: msg => {
          if (stale()) return
          // previousBlock advances on receipt; lastAppliedBlock only on durable commit
          const gap = msg.block > this.previousBlock + 1
          this.previousBlock = msg.block
          if (this.catchingUp) {
            this.buffer.push(msg)
          } else if (gap) {
            this.log.warn({ from: this.lastAppliedBlock, to: msg.block }, 'live gap detected')
            this.catchingUp = true
            this.buffer = [msg]
            void this.recoverAndDrain().catch(err => {
              this.log.error({ err: (err as Error).message }, 'gap recovery failed')
              this.subscription?.close()
              this.scheduleReconnect()
            })
          } else {
            void this.processQueue(msg)
          }
        },
        onDown: reason => {
          if (stale()) return
          this.log.warn({ reason }, 'indexer subscription down')
          this.scheduleReconnect()
        },
      },
      this.log,
    )
    this.subscription.connect()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS)
    this.reconnectAttempt += 1
    setTimeout(() => this.connect(), delay)
  }

  // TG-INGEST-3 when the graph is empty, TG-INGEST-5 otherwise; both end by draining the buffer
  private async catchUp(subscribed: SubscribedMessage): Promise<void> {
    if (this.lastAppliedBlock < 0) {
      await this.bootstrap(subscribed)
    } else {
      await this.recoverAndDrain()
      return
    }
    await this.drainBuffer()
  }

  private async bootstrap(subscribed: SubscribedMessage): Promise<void> {
    const snapshotBlock = subscribed.block - 1
    this.log.info({ snapshotBlock }, 'bootstrap: enumerating DID universe')
    const evidence = { block: snapshotBlock, blockTime: this.readyBlockTime }

    const pending: Promise<void>[] = []
    let active = 0
    let resolveIdle: (() => void) | null = null
    const runOne = async (did: string): Promise<void> => {
      try {
        const response = await this.rest.resolve(did, snapshotBlock)
        await this.applyResponse(response, evidence)
      } catch (err) {
        this.log.error({ did, err: (err as Error).message }, 'bootstrap resolve failed')
        throw err
      } finally {
        active -= 1
        resolveIdle?.()
      }
    }

    let count = 0
    for await (const did of this.rest.enumerateDids(snapshotBlock)) {
      while (active >= BOOTSTRAP_CONCURRENCY) {
        await new Promise<void>(res => {
          resolveIdle = res
        })
        resolveIdle = null
      }
      active += 1
      count += 1
      pending.push(runOne(did))
    }
    await Promise.all(pending)
    // concurrent snapshot resolves cannot see each other's writes; re-derive cross-DID facets
    await repairDerivedFacets(this.db)

    await this.db('ingestion_state')
      .insert({ id: 1, last_applied_block: snapshotBlock, last_block_time: this.readyBlockTime })
      .onConflict('id')
      .merge()
    this.lastAppliedBlock = snapshotBlock
    this.log.info({ snapshotBlock, dids: count }, 'bootstrap snapshot complete')
  }

  // TG-INGEST-5: replay from lastAppliedBlock + 1 until caught up or overlapping the buffer
  private async recoverAndDrain(): Promise<void> {
    // let any in-flight live block finish before replaying; recovery and live application
    // must never interleave on the same lastAppliedBlock
    await this.applyChain
    let from = this.lastAppliedBlock + 1
    for (;;) {
      const smallestBuffered = this.buffer[0]?.block
      const page = await this.rest.listChanges(from)
      for (const b of page.blocks) {
        if (smallestBuffered !== undefined && b.block >= smallestBuffered) break
        await this.applyBlock({ type: 'block', ...b })
      }
      if (page.nextFromBlock === null) break
      if (smallestBuffered !== undefined && page.nextFromBlock >= smallestBuffered) break
      from = page.nextFromBlock
    }
    await this.drainBuffer()
  }

  private async drainBuffer(): Promise<void> {
    while (this.buffer.length > 0) {
      const msg = this.buffer.shift() as BlockMessage
      if (msg.block <= this.lastAppliedBlock) continue
      if (msg.block > this.lastAppliedBlock + 1) {
        this.log.warn({ from: this.lastAppliedBlock + 1, to: msg.block - 1 }, 'buffered gap, replaying')
        await this.replayUpTo(msg.block)
      }
      if (msg.block <= this.lastAppliedBlock) continue
      await this.applyBlock(msg)
    }
    this.catchingUp = false
  }

  private async replayUpTo(exclusiveEnd: number): Promise<void> {
    let from = this.lastAppliedBlock + 1
    for (;;) {
      const page = await this.rest.listChanges(from)
      for (const b of page.blocks) {
        if (b.block >= exclusiveEnd) return
        await this.applyBlock({ type: 'block', ...b })
      }
      if (page.nextFromBlock === null || page.nextFromBlock >= exclusiveEnd) return
      from = page.nextFromBlock
    }
  }

  // Live blocks are applied strictly in order; a queue depth of one is enough because the WS
  // delivers in order and applyBlock is awaited
  private applyChain: Promise<void> = Promise.resolve()
  private processQueue(msg: BlockMessage): Promise<void> {
    this.applyChain = this.applyChain.then(() =>
      this.applyBlock(msg).catch(err => {
        this.log.error({ block: msg.block, err: (err as Error).message }, 'block apply failed')
        this.subscription?.close()
        this.scheduleReconnect()
      }),
    )
    return this.applyChain
  }

  // TG-INGEST-4: inline trust applied directly; exactly one resolve per changed (did, block),
  // pinned to the envelope's block. One block, one transaction, one commit, one BPS event.
  private async applyBlock(msg: BlockMessage): Promise<void> {
    if (msg.block <= this.lastAppliedBlock) return
    const evidence = { block: msg.block, blockTime: msg.blockTime }

    const resolves = new Map<string, ResolveResponse>()
    for (const envelope of msg.changes) {
      if (needsResolve(envelope)) {
        resolves.set(envelope.did, await this.rest.resolve(envelope.did, msg.block))
      }
    }

    const postCommit: (() => Promise<void>)[] = []
    await this.db.transaction(async trx => {
      for (const envelope of msg.changes) {
        await this.applyEnvelope(trx, envelope, resolves.get(envelope.did), evidence, postCommit)
      }
      await trx('ingestion_state')
        .insert({ id: 1, last_applied_block: msg.block, last_block_time: msg.blockTime })
        .onConflict('id')
        .merge()
    })
    this.lastAppliedBlock = msg.block
    this.events.emit('commit', { block: msg.block, blockTime: msg.blockTime })
    for (const task of postCommit) await task()
  }

  private async applyEnvelope(
    trx: Knex,
    envelope: ChangeEnvelope,
    response: ResolveResponse | undefined,
    evidence: { block: number; blockTime: string },
    postCommit: (() => Promise<void>)[],
  ): Promise<void> {
    if (typeof envelope.trust === 'object') {
      await applyInlineTrust(trx, envelope.did, envelope.trust, evidence)
    }
    if (response) {
      const loads = await reconcile(trx, response, evidence)
      this.queueDeref(response, loads, evidence, postCommit)
    }
  }

  private async applyResponse(
    response: ResolveResponse,
    evidence: { block: number; blockTime: string },
  ): Promise<void> {
    const postCommit: (() => Promise<void>)[] = []
    await this.db.transaction(async trx => {
      const loads = await reconcile(trx, response, evidence)
      this.queueDeref(response, loads, evidence, postCommit)
    })
    for (const task of postCommit) await task()
  }

  private queueDeref(
    response: ResolveResponse,
    loads: Parameters<Dereferencer['loadSchemas']>[0],
    evidence: { block: number; blockTime: string },
    postCommit: (() => Promise<void>)[],
  ): void {
    if (loads.length > 0) postCommit.push(() => this.deref.loadSchemas(loads))
    if (response.corporation?.cgf) {
      const c = response.corporation
      postCommit.push(() => this.deref.fetchGfDocs('cgf', c.id, c.cgf ?? null))
    }
    for (const eco of response.ecosystems ?? []) {
      if (eco.egf) postCommit.push(() => this.deref.fetchGfDocs('egf', eco.id, eco.egf ?? null))
    }
    if ((response.presentations ?? []).length > 0) {
      const p = response.presentations as NonNullable<typeof response.presentations>
      postCommit.push(() => this.deref.fetchVpBodies(response.did, p, evidence.block))
    }
  }
}
