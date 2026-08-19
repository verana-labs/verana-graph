import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { BlockMessage, ChangeEnvelope, ResolveResponse } from '../../src/indexer/types'

// A test double for the indexer's documented Verifiable Trust contract: resolve with
// At-Block-Height, DID enumeration, listChanges gap recovery, and the subscribe WebSocket.

export interface MockWorld {
  // per DID: snapshots keyed by the first block they are valid from
  snapshots: Map<string, Map<number, ResolveResponse>>
  schemaBodies: Map<number, string>
  blocks: BlockMessage[]
  readyBlock: number
  blockIntervalMs: number
}

export class MockIndexer {
  readonly resolveCalls: { did: string; height: number }[] = []
  private server!: Server
  private wss!: WebSocketServer
  private sockets = new Set<WebSocket>()
  port = 0
  // simulates a live gap
  suppressWs = false
  suppressAck = false
  resolveDelayMs = 0
  resolveDelayByDid = new Map<string, number>()

  constructor(readonly world: MockWorld) {}

  resolveAt(did: string, height: number): ResolveResponse | null {
    const versions = this.world.snapshots.get(did)
    if (!versions) return null
    let best: ResolveResponse | null = null
    let bestBlock = -1
    for (const [from, snap] of versions) {
      if (from <= height && from > bestBlock) {
        best = snap
        bestBlock = from
      }
    }
    return best
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const height = Number(req.headers['at-block-height'] ?? this.world.readyBlock)
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      if (req.method === 'POST' && url.pathname === '/v4/verifiable-trust/resolve') {
        let raw = ''
        req.on('data', c => {
          raw += c
        })
        req.on('end', async () => {
          const did = (JSON.parse(raw) as { did: string }).did
          this.resolveCalls.push({ did, height })
          const delay = this.resolveDelayByDid.get(did) ?? this.resolveDelayMs
          if (delay > 0) await new Promise(r => setTimeout(r, delay))
          const snap = this.resolveAt(did, height)
          if (!snap) return json(404, { error: 'unknown did' })
          json(200, snap)
        })
        return
      }
      if (url.pathname === '/v4/verifiable-trust/dids') {
        const dids = [...this.world.snapshots.entries()]
          .filter(([, versions]) => [...versions.keys()].some(from => from <= height))
          .map(([did]) => did)
        return json(200, { atBlock: height, dids, nextCursor: null })
      }
      if (url.pathname === '/v4/verifiable-trust/changes') {
        const fromBlock = Number(url.searchParams.get('fromBlock'))
        const blocks = this.world.blocks
          .filter(b => b.block >= fromBlock && b.changes.length > 0)
          .map(({ block, blockTime, changes }) => ({ block, blockTime, changes }))
        const currentBlock = this.world.blocks.at(-1)?.block ?? this.world.readyBlock - 1
        return json(200, { currentBlock, fromBlock, blocks, nextFromBlock: null })
      }
      const schemaMatch = url.pathname.match(/^\/v4\/credential-schema\/js\/(\d+)$/)
      if (schemaMatch) {
        const body = this.world.schemaBodies.get(Number(schemaMatch[1]))
        if (!body) return json(404, { error: 'unknown schema' })
        res.writeHead(200, { 'content-type': 'application/schema+json' })
        return res.end(body)
      }
      json(404, { error: `no route ${url.pathname}` })
    })

    this.wss = new WebSocketServer({ server: this.server, path: '/v4/verifiable-trust/subscribe' })
    this.wss.on('connection', ws => {
      this.sockets.add(ws)
      ws.on('close', () => this.sockets.delete(ws))
      ws.on('message', raw => {
        let control: { action?: string }
        try {
          control = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (control.action !== 'subscribe' || this.suppressAck) return
        const last = this.world.blocks.at(-1)?.block ?? this.world.readyBlock - 1
        ws.send(JSON.stringify({ type: 'subscribed', block: last + 1, blockTime: new Date().toISOString() }))
      })
      ws.send(
        JSON.stringify({
          type: 'ready',
          block: this.world.readyBlock,
          blockTime: new Date().toISOString(),
          blockIntervalMs: this.world.blockIntervalMs,
        }),
      )
    })

    await new Promise<void>(resolve => this.server.listen(0, resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  get baseUrl(): string {
    return `http://localhost:${this.port}`
  }

  get wsUrl(): string {
    return `ws://localhost:${this.port}`
  }

  dropSockets(): void {
    for (const ws of this.sockets) ws.terminate()
    this.sockets.clear()
  }

  pushBlock(msg: BlockMessage): void {
    this.world.blocks.push(msg)
    if (this.suppressWs) return
    for (const ws of this.sockets) ws.send(JSON.stringify(msg))
  }

  dropConnections(): void {
    for (const ws of this.sockets) ws.terminate()
    this.sockets.clear()
  }

  async stop(): Promise<void> {
    this.wss.close()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

export function block(blockNumber: number, changes: ChangeEnvelope[]): BlockMessage {
  return {
    type: 'block',
    block: blockNumber,
    blockTime: new Date(1700000000000 + blockNumber * 6000).toISOString(),
    changes,
  }
}
