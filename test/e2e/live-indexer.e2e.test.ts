import { readFileSync } from 'node:fs'
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import Fastify, { FastifyInstance } from 'fastify'
import { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import { registerSearchRoute } from '../../src/api/search/route'
import { registerTraverseRoute } from '../../src/api/traverse/route'
import { Dereferencer } from '../../src/deref/deref'
import { IndexerRestClient } from '../../src/indexer/rest'
import { IngestOrchestrator } from '../../src/ingest/orchestrator'
import { createLogger } from '../../src/util/logger'
import { freshDb, testConfig, waitFor } from '../harness/setup'

const INDEXER_URL = process.env.E2E_INDEXER_URL

const log = createLogger('silent')

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../spec/graph/${name}`, import.meta.url), 'utf8'))
}

const ajv = new Ajv({ strict: false })
addFormats.default(ajv as never)
const validateTraverse = ajv.compile(loadSchema('traverse.response.schema.json'))

describe.skipIf(!INDEXER_URL)('graph against a live indexer', () => {
  let db: Knex
  let orchestrator: IngestOrchestrator
  let app: FastifyInstance
  let baseUrl: string

  const post = async (path: string, body: unknown): Promise<{ status: number; body: never }> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as never }
  }

  beforeAll(async () => {
    const wsUrl = (INDEXER_URL as string).replace(/^http/, 'ws')
    db = await freshDb()
    const config = testConfig(INDEXER_URL as string, wsUrl)
    const rest = new IndexerRestClient(config.indexerBaseUrl)
    const deref = new Dereferencer(db, rest, config, log)
    orchestrator = new IngestOrchestrator(db, rest, deref, config.indexerWsUrl, log)
    await orchestrator.start()
    await waitFor(async () => {
      const row = await db('ingestion_state').where('id', 1).first()
      return row !== undefined && row.last_applied_block > 0
    }, 120_000)

    app = Fastify({ logger: false })
    app.setErrorHandler((err: unknown, _req, reply) => {
      if (err instanceof ApiError) return reply.status(err.httpStatus).send(err.toBody())
      throw err
    })
    registerTraverseRoute(app, db)
    registerSearchRoute(app, db, config)
    await app.listen({ port: 0 })
    const address = app.server.address()
    baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(async () => {
    orchestrator.stop()
    await app?.close()
    await db?.destroy()
  })

  it('bootstraps a snapshot from the subscribed anchor', async () => {
    const row = await db('ingestion_state').where('id', 1).first()
    expect(row.last_applied_block).toBeGreaterThan(0)
  })

  it('every trusted DID carries a pattern', async () => {
    const rows = await db('dids').where('trusted', true)
    for (const r of rows) expect(['A', 'B']).toContain(r.pattern)
  })

  it('every ECS credential carries its anchored issuance evidence', async () => {
    const rows = await db('ecs_credentials')
    for (const r of rows) {
      expect(r.digest_jcs).toBeTruthy()
      expect(r.issued_at_time).toBeTruthy()
    }
  })

  it('no non-ACTIVE participant is unreferenced (TG-ACT-1)', async () => {
    const orphans = await db('participants as p')
      .whereNot('p.state', 'ACTIVE')
      .whereNotExists(function () {
        this.select(1).from('ecs_credentials as ec').whereRaw('ec.issuer_participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('ecs_credentials as ec').whereRaw('ec.participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('vtcs as v').whereRaw('v.issuer_participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('vtcs as v').whereRaw('v.participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('participants as child').whereRaw('child.validator_participant_id = p.id')
      })
    expect(orphans).toEqual([])
  })

  it('A1 on a trusted DID validates against the published schema', async () => {
    const trusted = await db('dids').where('trusted', true).first()
    if (!trusted) return
    const { status, body } = await post('/v4/graph/traverse', { query: 'A1', input: { did: trusted.did } })
    expect(status).toBe(200)
    expect(validateTraverse(body)).toBe(true)
    expect((body as { output: { trusted: boolean } }).output.trusted).toBe(true)
  })

  it('pagination walks all participations and binds the cursor to its input', async () => {
    const rich = await db('participants')
      .select('did_id')
      .groupBy('did_id')
      .havingRaw('count(*) >= 2')
      .first()
    if (!rich) return
    const did = rich.did_id
    const whole = await post('/v4/graph/traverse', { query: 'A7', input: { did } })
    const all = (whole.body as { output: { participant: { id: number } }[] }).output.map(
      o => o.participant.id,
    )

    const walked: number[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await post('/v4/graph/traverse', {
        query: 'A7',
        input: { did },
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
      const b = page.body as { output: { participant: { id: number } }[]; nextCursor: string | null }
      walked.push(...b.output.map(o => o.participant.id))
      if (b.nextCursor === null) break
      cursor = b.nextCursor
    }
    expect(walked).toEqual(all)

    if (cursor) {
      const replay = await post('/v4/graph/traverse', {
        query: 'A7',
        input: { did: 'did:example:other' },
        limit: 1,
        cursor,
      })
      expect(replay.status).toBe(400)
      expect((replay.body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')
    }
  })

  it('search agrees with the persisted trusted set', async () => {
    const { status, body } = await post('/v4/graph/search', {
      surface: 'Did',
      filters: { 'Did.trusted': { eq: true } },
    })
    expect(status).toBe(200)
    const n = await db('dids').where('trusted', true).count('* as n').first()
    expect((body as { totalCount: number }).totalCount).toBe(Number(n?.n))
  })

  it('answers with the TG-ERR-1 contract', async () => {
    const unknown = await post('/v4/graph/traverse', { query: 'A1', input: { did: 'did:example:nobody' } })
    expect(unknown.status).toBe(404)
    expect((unknown.body as { error: { code: string } }).error.code).toBe('UNKNOWN_ID')

    const cur = await post('/v4/graph/search', { surface: 'Did', cursor: 'garbage' })
    expect(cur.status).toBe(400)
    expect((cur.body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')
  })

  it('follows the live chain', async () => {
    const start = (await db('ingestion_state').where('id', 1).first()).last_applied_block
    await waitFor(async () => {
      const row = await db('ingestion_state').where('id', 1).first()
      return row.last_applied_block > start
    }, 90_000)
  })
})
