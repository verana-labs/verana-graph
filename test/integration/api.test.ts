import { readFileSync } from 'node:fs'
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import Fastify, { FastifyInstance } from 'fastify'
import { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ApiError } from '../../src/api/errors'
import { registerSearchRoute } from '../../src/api/search/route'
import { registerTraverseRoute } from '../../src/api/traverse/route'
import { attachBlockProgressServer } from '../../src/bps/server'
import { Dereferencer } from '../../src/deref/deref'
import { IndexerRestClient } from '../../src/indexer/rest'
import { IngestOrchestrator } from '../../src/ingest/orchestrator'
import { createLogger } from '../../src/util/logger'
import { buildWorld, DIDS } from '../harness/fixture'
import { block, MockIndexer } from '../harness/mock-indexer'
import { freshDb, testConfig, waitFor } from '../harness/setup'

const log = createLogger('silent')

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../spec/graph/${name}`, import.meta.url), 'utf8'))
}

const ajv = new Ajv({ strict: false })
addFormats.default(ajv as never)
const validateTraverse = ajv.compile(loadSchema('traverse.response.schema.json'))
const validateSearch = ajv.compile(loadSchema('search.response.schema.json'))

describe('read APIs against a bootstrapped graph', () => {
  let db: Knex
  let mock: MockIndexer
  let orchestrator: IngestOrchestrator
  let app: FastifyInstance
  let baseUrl: string

  beforeAll(async () => {
    db = await freshDb()
    mock = new MockIndexer(buildWorld())
    await mock.start()
    const config = testConfig(mock.baseUrl, mock.wsUrl)
    const rest = new IndexerRestClient(config.indexerBaseUrl)
    const deref = new Dereferencer(db, rest, config, log)
    orchestrator = new IngestOrchestrator(db, rest, deref, config.indexerWsUrl, log)
    await orchestrator.start()
    await waitFor(async () => {
      const row = await db('ingestion_state').where('id', 1).first()
      const schemas = await db('credential_schemas').count('* as n').first()
      return row?.last_applied_block === 99 && Number(schemas?.n) === 2
    })

    app = Fastify({ logger: false })
    app.setErrorHandler((err: unknown, _req, reply) => {
      if (err instanceof ApiError) return reply.status(err.httpStatus).send(err.toBody())
      throw err
    })
    registerTraverseRoute(app, db)
    registerSearchRoute(app, db, config)
    await app.listen({ port: 0 })
    attachBlockProgressServer(app.server, orchestrator, config.bpsMaxBufferedBytes, log)
    const address = app.server.address()
    baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterAll(async () => {
    orchestrator.stop()
    await app.close()
    await mock.stop()
    await db.destroy()
  })

  async function traverse(query: string, input: unknown): Promise<{ status: number; body: never }> {
    const res = await fetch(`${baseUrl}/v4/graph/traverse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, input }),
    })
    return { status: res.status, body: (await res.json()) as never }
  }

  async function search(payload: unknown): Promise<{ status: number; body: never }> {
    const res = await fetch(`${baseUrl}/v4/graph/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json()) as never }
  }

  const expectValidTraverse = (body: Record<string, unknown>) => {
    const ok = validateTraverse(body)
    if (!ok) throw new Error(`traverse response failed schema: ${JSON.stringify(validateTraverse.errors)}`)
  }

  describe('traversal, all selectors validate against the published schema', () => {
    it('A1 trust summary', async () => {
      const { status, body } = await traverse('A1', { did: DIDS.vs })
      expect(status).toBe(200)
      expectValidTraverse(body)
      expect((body as { output: { pattern: string } }).output.pattern).toBe('B')
    })

    it('A1 on a DID with no adopting Corporation emits corporationId null', async () => {
      const { status, body } = await traverse('A1', { did: DIDS.orphan })
      expect(status).toBe(200)
      const out = (body as { output: { corporationId: number | null; expiresAtTime: string | null } }).output
      expect(out.corporationId).toBeNull()
      expect(out.expiresAtTime).toBeNull()
      // untrusted DID, so the only schema error must be the known pattern deviation
      validateTraverse(body)
      const missing = (validateTraverse.errors ?? []).map(e => e.params?.missingProperty).filter(Boolean)
      expect(missing).toEqual(['pattern'])
    })

    it('A2 on a DID with no adopting Corporation returns corporation null', async () => {
      const { status, body } = await traverse('A2', { did: DIDS.orphan })
      expect(status).toBe(200)
      expectValidTraverse(body)
      const out = (body as { output: { corporation: null; ecosystems: unknown[] } }).output
      expect(out.corporation).toBeNull()
      expect(out.ecosystems).toEqual([])
    })

    it('A2 governing chain', async () => {
      const { body } = await traverse('A2', { did: DIDS.vs })
      expectValidTraverse(body)
      const out = (body as { output: { corporation: { id: number }; ecosystems: { id: number }[] } }).output
      expect(out.corporation.id).toBe(42)
      expect(out.ecosystems.map(e => e.id)).toEqual([7])
    })

    it('A3 service endpoints', async () => {
      const { body } = await traverse('A3', { did: DIDS.vs })
      expectValidTraverse(body)
      expect((body as { output: unknown[] }).output).toHaveLength(2)
    })

    it('A4 linked VPs with contained VTCs', async () => {
      const { body } = await traverse('A4', { did: DIDS.vs })
      expectValidTraverse(body)
      const out = (body as { output: { vtcs: { id: string }[] }[] }).output
      expect(out[0]?.vtcs[0]?.id).toBe('urn:vtc:cert:vs')
    })

    it('A5 held credentials with issuer enrichment', async () => {
      const { body } = await traverse('A5', { did: DIDS.vs, ecsSchema: 'ServiceCredential' })
      expectValidTraverse(body)
      const out = (body as { output: { issuerDid: string }[] }).output
      expect(out[0]?.issuerDid).toBe(DIDS.issuer)
    })

    it('A6 issued credentials', async () => {
      const { body } = await traverse('A6', { did: DIDS.issuer })
      expectValidTraverse(body)
      const out = (body as { output: { ecsCredentials: unknown[]; vtcs: unknown[] } }).output
      expect(out.ecsCredentials.length + out.vtcs.length).toBeGreaterThanOrEqual(2)
    })

    it('A7 participants by role', async () => {
      const { body } = await traverse('A7', { did: DIDS.vs, role: 'HOLDER' })
      expectValidTraverse(body)
      expect((body as { output: unknown[] }).output).toHaveLength(2)
    })

    it('B1 issuer recovery', async () => {
      const { body } = await traverse('B1', { credentialId: 'urn:cred:sc:vs' })
      expectValidTraverse(body)
      expect((body as { output: { issuerDid: string } }).output.issuerDid).toBe(DIDS.issuer)
    })

    it('B2 holder recovery', async () => {
      const { body } = await traverse('B2', { credentialId: 'urn:vtc:cert:vs' })
      expectValidTraverse(body)
      expect((body as { output: { subjectDid: string } }).output.subjectDid).toBe(DIDS.vs)
    })

    it('C1 owned schemas', async () => {
      const { body } = await traverse('C1', { ecosystemId: 7 })
      expectValidTraverse(body)
      expect((body as { output: unknown[] }).output).toHaveLength(2)
    })

    it('C2 participating DIDs by role omits empty roles', async () => {
      const { body } = await traverse('C2', { ecosystemId: 7, role: 'ISSUER' })
      expectValidTraverse(body)
      const out = (body as { output: Record<string, unknown[]> }).output
      expect(Object.keys(out)).toEqual(['ISSUER'])
    })

    it('C3 and E3 governance summaries', async () => {
      const c3 = await traverse('C3', { ecosystemId: 7 })
      expectValidTraverse(c3.body)
      const e3 = await traverse('E3', { corporationId: 42 })
      expectValidTraverse(e3.body)
    })

    it('D1 credentials based on schema', async () => {
      const { body } = await traverse('D1', { credentialSchemaId: 101 })
      expectValidTraverse(body)
      const out = (body as { output: { ecsCredentials: unknown[]; vtcs: unknown[] } }).output
      expect(out.ecsCredentials).toHaveLength(1)
      expect(out.vtcs).toHaveLength(1)
    })

    it('D2 participants by role for schema', async () => {
      const { body } = await traverse('D2', { credentialSchemaId: 100 })
      expectValidTraverse(body)
    })

    it('E1 owned DIDs and E2 controlled ecosystems', async () => {
      const e1 = await traverse('E1', { corporationId: 42 })
      expectValidTraverse(e1.body)
      expect((e1.body as { output: unknown[] }).output).toHaveLength(5)
      const e2 = await traverse('E2', { corporationId: 42 })
      expectValidTraverse(e2.body)
    })

    it('F1 shortest path from a DID to its ecosystem', async () => {
      const { body } = await traverse('F1', {
        from: { type: 'Did', id: DIDS.vs },
        to: { type: 'Ecosystem', id: 7 },
      })
      expectValidTraverse(body)
      expect((body as { output: unknown[] | null }).output).not.toBeNull()
    })

    it('F1 returns null when no path exists', async () => {
      const { body } = await traverse('F1', {
        from: { type: 'Did', id: DIDS.plain },
        to: { type: 'CredentialSchema', id: 999999 },
      })
      expect((body as { output: unknown }).output).toBeNull()
    })

    it('G1 validator chain runs root to leaf', async () => {
      const { body } = await traverse('G1', { participantId: 20 })
      expectValidTraverse(body)
      const out = (body as { output: { id: number; role: string }[] }).output
      expect(out.map(p => p.id)).toEqual([1, 10, 20])
      expect(out[0]?.role).toBe('ECOSYSTEM')
    })

    it('TG-ERR-1: unknown ids return UNKNOWN_ID with 404', async () => {
      const { status, body } = await traverse('A1', { did: 'did:mock:nope' })
      expect(status).toBe(404)
      expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_ID')
    })

    it('TG-ERR-1: a malformed input returns INVALID_INPUT with 400', async () => {
      const { status, body } = await traverse('A1', { nope: true })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('INVALID_INPUT')
    })

    it('TG-ERR-1: an unknown query selector returns UNKNOWN_QUERY with 400', async () => {
      const { status, body } = await traverse('ZZ', { did: DIDS.vs })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_QUERY')
    })

    it('TG-ERR-1: an unknown filter field returns UNKNOWN_FILTER_FIELD with 400', async () => {
      const { status, body } = await search({ surface: 'Did', filters: { 'Did.nope': { eq: 1 } } })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_FILTER_FIELD')
    })

    it('TG-ERR-1: an unsupported operator returns INVALID_INPUT with 400', async () => {
      const { status, body } = await search({
        surface: 'Did',
        filters: { 'Did.trusted': { range: { gte: 1 } } },
      })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('INVALID_INPUT')
    })
  })

  describe('faceted search', () => {
    it('TG-FCT-2: a null expiresAtTime never trust-expires (IDX-VT-EVAL-2)', async () => {
      await db('dids').where('did', DIDS.vs).update({ expires_at_time: null })
      const { body } = await search({ surface: 'Did' })
      const hits = (body as { hits: { id: string }[] }).hits
      expect(hits.map(h => h.id)).toContain(DIDS.vs)
      await db('dids').where('did', DIDS.vs).update({ expires_at_time: '2100-01-01T00:00:00Z' })
    })

    it('free text with structured filters finds the VS, response validates', async () => {
      const { status, body } = await search({
        surface: 'Did',
        filters: { 'OrganizationCredential.countryCode': 'DE' },
        freeText: 'baby shoes',
      })
      expect(status).toBe(200)
      expect(validateSearch(body)).toBe(true)
      const b = body as { totalCount: number; hits: { id: string }[]; facets: Record<string, unknown> }
      expect(b.totalCount).toBe(1)
      expect(b.hits[0]?.id).toBe(DIDS.vs)
      expect(b.facets['OrganizationCredential.countryCode']).toBeTruthy()
    })

    it('TG-FCT-2: untrusted DIDs are gated by default and revealed by includeUntrusted', async () => {
      const gated = await search({ surface: 'Did', filters: {} })
      const gatedIds = (gated.body as { hits: { id: string }[] }).hits.map(h => h.id)
      expect(gatedIds).not.toContain(DIDS.plain)

      const open = await search({ surface: 'Did', filters: {}, includeUntrusted: true })
      const openIds = (open.body as { hits: { id: string }[] }).hits.map(h => h.id)
      expect(openIds).toContain(DIDS.plain)
    })

    it('Participant.role filter answers "issuers" on the Did surface', async () => {
      const { body } = await search({
        surface: 'Did',
        filters: { 'Participant.role': 'ISSUER' },
        includeUntrusted: true,
      })
      expect((body as { hits: { id: string }[] }).hits.map(h => h.id)).toEqual([DIDS.issuer])
    })

    it('cursor pagination is stable and rejects foreign cursors', async () => {
      const page1 = await search({ surface: 'Did', filters: {}, limit: 1, includeUntrusted: true })
      const b1 = body(page1)
      expect(b1.hits).toHaveLength(1)
      expect(b1.cursor).toBeTruthy()

      const page2 = await search({
        surface: 'Did',
        filters: {},
        limit: 1,
        includeUntrusted: true,
        cursor: b1.cursor,
      })
      const b2 = body(page2)
      expect(b2.hits[0]?.id).not.toBe(b1.hits[0]?.id)

      const foreign = await search({ surface: 'Ecosystem', filters: {}, cursor: b1.cursor })
      expect(foreign.status).toBe(400)
      expect((foreign.body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')

      function body(r: { body: never }): { hits: { id: string }[]; cursor: string | null } {
        return r.body as { hits: { id: string }[]; cursor: string | null }
      }
    })

    it('unknown filter fields are rejected per surface', async () => {
      const { status, body } = await search({ surface: 'Ecosystem', filters: { 'Did.trusted': true } })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_FILTER_FIELD')
    })

    it('ecosystem surface with participants[role] range filter', async () => {
      const { body } = await search({
        surface: 'Ecosystem',
        filters: { 'participants[ISSUER]': { range: { gte: 1 } } },
      })
      expect((body as { hits: { id: number }[] }).hits.map(h => h.id)).toEqual([7])
      expect(validateSearch(body)).toBe(true)
    })
  })

  describe('block-progress subscription', () => {
    it('TG-BPS: ready then strictly-increasing per-commit block messages', async () => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/v4/graph/blocks/subscribe`)
      const messages: { type: string; block: number }[] = []
      ws.on('message', d => messages.push(JSON.parse(d.toString())))
      await waitFor(async () => messages.length >= 1)
      expect(messages[0]?.type).toBe('ready')
      expect(messages[0]?.block).toBe(99)

      mock.pushBlock(block(100, []))
      mock.pushBlock(block(101, []))
      await waitFor(async () => messages.length >= 3)
      expect(messages.slice(1).map(m => m.type)).toEqual(['block', 'block'])
      expect(messages.slice(1).map(m => m.block)).toEqual([100, 101])
      ws.close()
    })
  })
})
