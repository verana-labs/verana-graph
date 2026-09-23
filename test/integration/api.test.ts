import { readFileSync } from 'node:fs'
import { Ajv2020 as Ajv } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import Fastify, { FastifyInstance } from 'fastify'
import { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { registerDocs } from '../../src/api/docs'
import { apiErrorHandler } from '../../src/api/errors'
import { queryHash } from '../../src/api/search/cursor'
import { registerSearchRoute } from '../../src/api/search/route'
import { pageHash } from '../../src/api/traverse/cursor'
import { registerTraverseRoute } from '../../src/api/traverse/route'
import { attachBlockProgressServer } from '../../src/bps/server'
import { Dereferencer } from '../../src/deref/deref'
import { IndexerRestClient } from '../../src/indexer/rest'
import { IngestOrchestrator } from '../../src/ingest/orchestrator'
import { createLogger } from '../../src/util/logger'
import { buildWorld, DIDS, DIGESTS, issuerSnapshot, SCHEMA_BODIES } from '../harness/fixture'
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
const validateError = ajv.compile(loadSchema('error.schema.json'))

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
    app.setErrorHandler(apiErrorHandler(() => {}))
    registerTraverseRoute(app, db)
    registerSearchRoute(app, db)
    registerDocs(app)
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

  async function traverse(
    query: string,
    input: unknown,
    page?: { limit?: number; cursor?: string | null },
  ): Promise<{ status: number; body: never }> {
    const res = await fetch(`${baseUrl}/v4/graph/traverse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        input,
        ...(page?.limit !== undefined ? { limit: page.limit } : {}),
        ...(page?.cursor ? { cursor: page.cursor } : {}),
      }),
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
      const out = (
        body as { output: { corporationId: number | null; expiresAtTime: string | null; pattern: null } }
      ).output
      expect(out.corporationId).toBeNull()
      expect(out.expiresAtTime).toBeNull()
      expect(out.pattern).toBeNull()
      // the only schema error must be the known corporationId deviation, see migration 0002
      validateTraverse(body)
      const paths = (validateTraverse.errors ?? []).map(e => e.instancePath).filter(Boolean)
      expect(new Set(paths)).toEqual(new Set(['/output/corporationId']))
    })

    it('A2 on a DID with no adopting Corporation returns corporation null', async () => {
      const { status, body } = await traverse('A2', { did: DIDS.orphan })
      expect(status).toBe(200)
      const out = (body as { output: { corporation: null; ecosystems: unknown[] } }).output
      expect(out.corporation).toBeNull()
      expect(out.ecosystems).toEqual([])
      // the spec makes corporationId non-null (DID ownership invariant) but the live
      // indexer returns null here, see migration 0002 and fixture finding L1
      validateTraverse(body)
      const paths = (validateTraverse.errors ?? []).map(e => e.instancePath)
      expect(paths).toContain('/output/corporation')
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

    it('TG-QRY-3: a corporation, schema or ecosystem not yet materialised comes back id-only', async () => {
      const cred = db('ecs_credentials').where('id', 'urn:cred:sc:vs')
      await db('dids').where('did', DIDS.vs).update({ corporation_id: 999 })
      await cred.clone().update({ credential_schema_id: 998, ecosystem_id: 997 })
      await db('participants').where('id', 20).update({ credential_schema_id: 998, ecosystem_id: 997 })
      await db('participants').where('id', 21).update({ credential_schema_id: 998 })
      const [a2, a5, a6, a7, b1] = await Promise.all([
        traverse('A2', { did: DIDS.vs }),
        traverse('A5', { did: DIDS.vs }),
        traverse('A6', { did: DIDS.issuer }),
        traverse('A7', { did: DIDS.vs }),
        traverse('B1', { did: DIDS.vs, credentialId: 'urn:cred:sc:vs' }),
      ])
      await db('dids').where('did', DIDS.vs).update({ corporation_id: 42 })
      await cred.clone().update({ credential_schema_id: 100, ecosystem_id: 7 })
      await db('participants').where('id', 20).update({ credential_schema_id: 100, ecosystem_id: 7 })
      await db('participants').where('id', 21).update({ credential_schema_id: 101 })

      for (const r of [a2, a5, a6, a7, b1]) expectValidTraverse(r.body)
      const idOnly = expect.objectContaining({ schema: { id: 998 }, ecosystem: { id: 997 } })
      const out = (r: { body: never }) => (r.body as { output: never }).output
      expect(out(a2)).toEqual({ corporation: { id: 999 }, ecosystems: [expect.objectContaining({ id: 7 })] })
      expect(out(a5)).toEqual([idOnly])
      expect((out(a6) as { ecsCredentials: unknown[] }).ecsCredentials).toContainEqual(idOnly)
      expect((out(a7) as unknown[])[0]).toEqual(idOnly)
      expect(out(b1)).toEqual(idOnly)
    })

    it('TG-QRY-6: limit bounds the page and nextCursor walks the rest', async () => {
      const first = await traverse('A7', { did: DIDS.vs }, { limit: 1 })
      const page1 = first.body as { output: unknown[]; nextCursor: string | null }
      expect(page1.output).toHaveLength(1)
      expect(page1.nextCursor).toBeTypeOf('string')

      const second = await traverse('A7', { did: DIDS.vs }, { limit: 1, cursor: page1.nextCursor })
      const page2 = second.body as { output: unknown[]; nextCursor: string | null }
      expect(page2.output).toHaveLength(1)
      expect(page2.nextCursor).toBeNull()

      const ids = [...page1.output, ...page2.output].map(
        i => (i as { participant: { id: number } }).participant.id,
      )
      expect(new Set(ids).size).toBe(2)

      const whole = await traverse('A7', { did: DIDS.vs })
      const allIds = (whole.body as { output: unknown[] }).output.map(
        i => (i as { participant: { id: number } }).participant.id,
      )
      expect(ids).toEqual(allIds)
    })

    it('TG-QRY-6: a shape-fixed query ignores limit/cursor and returns nextCursor null', async () => {
      const { body } = await traverse('A1', { did: DIDS.vs }, { limit: 1 })
      expect((body as { nextCursor: string | null }).nextCursor).toBeNull()
    })

    it('TG-QRY-6: a cursor replayed against different input is rejected', async () => {
      const first = await traverse('A7', { did: DIDS.vs }, { limit: 1 })
      const cursor = (first.body as { nextCursor: string }).nextCursor
      const { status, body } = await traverse('A7', { did: DIDS.issuer }, { limit: 1, cursor })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')
    })

    it('B1 issuer recovery', async () => {
      const { body } = await traverse('B1', { did: DIDS.vs, credentialId: 'urn:cred:sc:vs' })
      expectValidTraverse(body)
      expect((body as { output: { issuerDid: string } }).output.issuerDid).toBe(DIDS.issuer)
    })

    it('B2 holder recovery', async () => {
      const { body } = await traverse('B2', { did: DIDS.vs, credentialId: 'urn:vtc:cert:vs' })
      expectValidTraverse(body)
      expect((body as { output: { subjectDid: string } }).output.subjectDid).toBe(DIDS.vs)
    })

    it('B1 and B2 match a VTC only among the VTCs the did presents', async () => {
      for (const query of ['B1', 'B2']) {
        const { status, body } = await traverse(query, { did: DIDS.issuer, credentialId: 'urn:vtc:cert:vs' })
        expect(status).toBe(404)
        expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_ID')
      }
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
      expect(out.ecsCredentials).toHaveLength(2)
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
        from: { type: 'Did', id: DIDS.orphan },
        to: { type: 'CredentialSchema', id: 100 },
      })
      expectValidTraverse(body)
      expect((body as { output: unknown }).output).toBeNull()
    })

    it('F1 walks service, VP and VTC edges', async () => {
      const se = await traverse('F1', {
        from: { type: 'Did', id: DIDS.vs },
        to: { type: 'ServiceEndpoint', id: `${DIDS.vs}#mcp` },
      })
      expectValidTraverse(se.body)
      expect((se.body as { output: unknown }).output).toEqual([
        { node: { type: 'Did', id: DIDS.vs }, edge: 'EXPOSES_SERVICE' },
        { node: { type: 'ServiceEndpoint', id: `${DIDS.vs}#mcp` } },
      ])
      const vp = await traverse('F1', {
        from: { type: 'LinkedVerifiablePresentation', id: 'https://vs.mock/vp1.json' },
        to: { type: 'Ecosystem', id: 7 },
      })
      expectValidTraverse(vp.body)
      expect((vp.body as { output: unknown }).output).toEqual([
        {
          node: { type: 'LinkedVerifiablePresentation', id: 'https://vs.mock/vp1.json' },
          edge: 'CONTAINS_VTC',
        },
        { node: { type: 'Vtc', id: 'urn:vtc:cert:vs' }, edge: 'GOVERNED_BY' },
        { node: { type: 'Ecosystem', id: 7 } },
      ])
    })

    it('F1 returns UNKNOWN_ID for an endpoint that resolves to no record', async () => {
      for (const from of [
        { type: 'EcsCredential', id: 'urn:cred:nope' },
        { type: 'CredentialSchema', id: 999999 },
        { type: 'Corporation', id: 'not-an-id' },
      ]) {
        const { status, body } = await traverse('F1', { from, to: { type: 'Did', id: DIDS.vs } })
        expect(status).toBe(404)
        expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_ID')
      }
    })

    it('G1 validator chain runs root to leaf', async () => {
      const { body } = await traverse('G1', { participantId: 20 })
      expectValidTraverse(body)
      const out = (body as { output: { id: number; role: string }[] }).output
      expect(out.map(p => p.id)).toEqual([1, 10, 20])
      expect(out[0]?.role).toBe('ECOSYSTEM')
    })

    it('TG-ERR-1: unknown ids return UNKNOWN_ID with 404', async () => {
      for (const [query, input] of [
        ['A1', { did: 'did:mock:nope' }],
        ['C1', { ecosystemId: 1e19 }],
        ['C1', { ecosystemId: 2 ** 63 }],
        ['E1', { corporationId: 1e30 }],
        ['G1', { participantId: 1e19 }],
      ] as const) {
        const { status, body } = await traverse(query, input)
        expect(status, JSON.stringify(input)).toBe(404)
        expect(validateError(body)).toBe(true)
        expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_ID')
      }
    })

    it('TG-ERR-1: a malformed input returns INVALID_INPUT with 400', async () => {
      for (const [query, input] of [
        ['A1', { nope: true }],
        ['A1', { did: 'did:\u0000' }],
        ['B1', { did: DIDS.vs, credentialId: 'x\u0000' }],
        ['F1', { from: { type: 'Did', id: 'did:\u0000' }, to: { type: 'Ecosystem', id: 7 } }],
        ['F1', { from: { type: 'Did', id: DIDS.vs }, to: { type: 'Vtc', id: 'x\u0000' } }],
      ] as const) {
        const { status, body } = await traverse(query, input)
        expect(status, JSON.stringify(input)).toBe(400)
        expect(validateError(body)).toBe(true)
        expect((body as { error: { code: string } }).error.code).toBe('INVALID_INPUT')
      }
    })

    it('TG-ERR-1: an unknown query selector returns UNKNOWN_QUERY with 400', async () => {
      for (const query of ['ZZ', 'toString', '__proto__']) {
        const { status, body } = await traverse(query, { did: DIDS.vs })
        expect(status, query).toBe(400)
        expect((body as { error: { code: string } }).error.code).toBe('UNKNOWN_QUERY')
      }
    })

    it('TG-ERR-1: a cursor with a forged key returns INVALID_CURSOR with 400', async () => {
      const forge = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url')
      const did = { did: DIDS.vs }
      for (const { status, body } of [
        await search({
          surface: 'Ecosystem',
          cursor: forge({ s: 0, k: 'abc', h: queryHash({ surface: 'Ecosystem' }) }),
        }),
        await search({
          surface: 'Did',
          cursor: forge({ s: 0, k: '\u0000', h: queryHash({ surface: 'Did' }) }),
        }),
        await traverse('A7', did, { cursor: forge({ k: '1e400', h: pageHash('A7', did) }) }),
        await traverse('A4', did, { cursor: forge({ k: '\u0000', h: pageHash('A4', did) }) }),
      ]) {
        expect(status).toBe(400)
        expect((body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')
      }
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

    it('TG-ERR-1: a filter value of the wrong type or a NUL character returns INVALID_INPUT with 400, never a 500', async () => {
      for (const [surface, filters] of [
        ['Did', { 'Did.corporationId': 'abc' }],
        ['Did', { 'Participant.ecosystemId': 'x' }],
        ['Did', { 'Did.isCorporation': 1 }],
        ['Did', { 'Did.isEcosystem': 'true' }],
        ['Did', { 'Did.pattern': 'A\u0000' }],
        ['Ecosystem', { archived: 'yes' }],
        ['Ecosystem', { issuedCredentials: { range: { gte: 'abc' } } }],
        ['Corporation', { deposit: { range: { gte: '40000000uvna' } } }],
        ['Did', { 'EcsCredential.ServiceCredential.minimumAgeRequired': { range: { lte: 3000000000 } } }],
        ['Corporation', { lastSlashedAtTime: { range: { gte: '2026-02-30T00:00:00Z' } } }],
        ['Corporation', { lastSlashedAtTime: { range: { gte: '0000-01-01T00:00:00Z' } } }],
        ['CredentialSchema', { archived: 1 }],
      ] as const) {
        const { status, body } = await search({ surface, filters })
        expect(status, JSON.stringify(filters)).toBe(400)
        expect(validateError(body)).toBe(true)
        expect((body as { error: { code: string } }).error.code).toBe('INVALID_INPUT')
      }
      expect((await search({ surface: 'Did', freeText: 'a\u0000' })).status).toBe(400)
      for (const [surface, filters] of [
        ['Did', { 'Did.corporationId': '42' }],
        ['Corporation', { deposit: { range: { lte: '100000000000000000000' } } }],
      ] as const) {
        const { status } = await search({ surface, filters })
        expect(status, JSON.stringify(filters)).toBe(200)
      }
    })

    it('TG-ERR-1: unparseable bodies and non-POST methods return INVALID_INPUT with 400', async () => {
      const json = { 'content-type': 'application/json' }
      const responses = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/v4/graph/search',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: '{"surface":"Did"}',
        }),
        app.inject({ method: 'POST', url: '/v4/graph/traverse', headers: json, payload: '{"query":' }),
        app.inject({
          method: 'POST',
          url: '/v4/graph/search',
          headers: json,
          payload: JSON.stringify({ surface: 'Did', freeText: 'x'.repeat(2_000_000) }),
        }),
        app.inject({ method: 'GET', url: '/v4/graph/search' }),
        app.inject({ method: 'DELETE', url: '/v4/graph/traverse' }),
      ])
      for (const res of responses) {
        const body = res.json()
        expect(res.statusCode).toBe(400)
        expect(validateError(body)).toBe(true)
        expect((body as { error: { code: string } }).error.code).toBe('INVALID_INPUT')
      }
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
      expect(b.facets['OrganizationCredential.countryCode']).toEqual([{ value: 'DE', count: 1 }])
    })

    it('TG-FCT-2: untrusted DIDs are gated by default and revealed by includeUntrusted', async () => {
      const gated = await search({ surface: 'Did', filters: {} })
      const gatedIds = (gated.body as { hits: { id: string }[] }).hits.map(h => h.id)
      expect(gatedIds).not.toContain(DIDS.plain)

      const open = await search({ surface: 'Did', filters: {}, includeUntrusted: true })
      const openIds = (open.body as { hits: { id: string }[] }).hits.map(h => h.id)
      expect(openIds).toContain(DIDS.plain)
    })

    it('TG-FCT-2: ServiceEndpoint hits follow the owning DID trust gate and includeUntrusted', async () => {
      await db('dids').where('did', DIDS.vs).update({ trusted: false })
      const gated = await search({ surface: 'ServiceEndpoint' })
      const open = await search({ surface: 'ServiceEndpoint', includeUntrusted: true })
      await db('dids').where('did', DIDS.vs).update({ trusted: true })

      const g = gated.body as { totalCount: number; hits: { id: string }[]; facets: Record<string, unknown> }
      expect(g.hits.map(h => h.id)).toEqual([`${DIDS.issuer}#didcomm`])
      expect(g.totalCount).toBe(1)
      expect(g.facets.type).toEqual([{ value: 'did-communication', count: 1 }])
      const o = open.body as { totalCount: number; hits: { id: string }[] }
      expect(o.totalCount).toBe(3)
      expect(o.hits.map(h => h.id)).toContain(`${DIDS.vs}#mcp`)
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

    it('TG-FCT-7: an empty cursor is rejected, never silently re-anchored', async () => {
      const { status, body } = await search({ surface: 'Did', cursor: '' })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')
    })

    it('TG-FCT-7: a cursor decoding to null is rejected, not a 500', async () => {
      const cursor = Buffer.from('null').toString('base64url')
      const { status, body } = await search({ surface: 'Did', cursor })
      expect(status).toBe(400)
      expect((body as { error: { code: string } }).error.code).toBe('INVALID_CURSOR')
    })

    it('TG-FCT-4: free text over the bound DID identity finds the Ecosystem and the Corporation', async () => {
      const eco = await search({ surface: 'Ecosystem', freeText: 'banking registry' })
      expect((eco.body as { hits: { id: number }[] }).hits.map(h => h.id)).toEqual([7])
      const corp = await search({ surface: 'Corporation', freeText: 'Verana Holdings' })
      expect((corp.body as { hits: { id: number }[] }).hits.map(h => h.id)).toEqual([42])
    })

    it('TG-FCT-4a: freeText tokens split on punctuation and all must match, with no operators', async () => {
      const ids = async (payload: Record<string, unknown>): Promise<unknown[]> =>
        ((await search(payload)).body as { hits: { id: unknown }[] }).hits.map(h => h.id)
      expect(await ids({ surface: 'Did', freeText: 'baby or zzzqqq' })).toEqual([])
      expect(await ids({ surface: 'Did', freeText: 'baby -shoes' })).toEqual([DIDS.vs])
      expect(await ids({ surface: 'Did', freeText: '"shoes baby"' })).toEqual([DIDS.vs])
      expect(await ids({ surface: 'CredentialSchema', freeText: 'schema-organization' })).toEqual([101])
      expect(await ids({ surface: 'CredentialSchema', freeText: '- "' })).toEqual(
        await ids({ surface: 'CredentialSchema' }),
      )
      expect(await ids({ surface: 'CredentialSchema', freeText: 'zq'.repeat(1024) })).toEqual([])
      expect(await ids({ surface: 'ServiceEndpoint', freeText: 'vs.mock MCP' })).toEqual(['did:mock:vs#mcp'])

      const endpoint = { uri: 'https://relay.example', accept: ['didcomm/v2'] }
      await db('service_endpoints')
        .where('id', 'did:mock:vs#mcp')
        .update({ service_endpoint: JSON.stringify(endpoint) })
      const nested = await ids({ surface: 'ServiceEndpoint', freeText: 'relay v2' })
      const key = await ids({ surface: 'ServiceEndpoint', freeText: 'accept' })
      await db('service_endpoints')
        .where('id', 'did:mock:vs#mcp')
        .update({ service_endpoint: JSON.stringify('https://vs.mock/mcp') })
      expect(nested).toEqual(['did:mock:vs#mcp'])
      expect(key).toEqual([])
    })

    it('ecosystem surface with participants[role] range filter', async () => {
      const { body } = await search({
        surface: 'Ecosystem',
        filters: { 'participants[ISSUER]': { range: { gte: 1 } } },
      })
      expect((body as { hits: { id: number }[] }).hits.map(h => h.id)).toEqual([7])
      expect(validateSearch(body)).toBe(true)
    })

    it('a role missing from the participants map counts as zero', async () => {
      const { body } = await search({
        surface: 'Ecosystem',
        filters: { 'participants[VERIFIER]': { range: { lte: 0 } } },
      })
      expect((body as { hits: { id: number }[] }).hits.map(h => h.id)).toEqual([7])
    })

    it('TG-FCT-6: the Did surface carries its default facets and never the near-unique ones', async () => {
      const { body } = await search({ surface: 'Did' })
      expect(validateSearch(body)).toBe(true)
      const facets = (body as { facets: Record<string, unknown> }).facets
      expect(facets['Did.operatorKind']).toEqual([{ value: 'Organization', count: 2 }])
      expect(facets['EcsCredential.ServiceCredential.type']).toEqual([{ value: 'ECommerce', count: 1 }])
      expect(facets['OrganizationCredential.countryCode']).toEqual([{ value: 'DE', count: 2 }])
      expect(Object.keys(facets)).not.toContain('OrganizationCredential.lei')
      expect(Object.keys(facets)).not.toContain('OrganizationCredential.registryId')
      expect(Object.keys(facets)).not.toContain('Did.operatorName')
    })

    it('TG-FCT-6: a prefix filter adds no facet, an in filter adds one next to the defaults', async () => {
      const prefixed = await search({ surface: 'Did', filters: { 'Did.operatorName': { prefix: 'Acme' } } })
      const prefixedKeys = Object.keys((prefixed.body as { facets: Record<string, unknown> }).facets)
      expect(prefixedKeys).not.toContain('Did.operatorName')
      expect(prefixedKeys).toContain('Did.operatorKind')

      const listed = await search({ surface: 'Did', filters: { 'Did.pattern': ['A', 'B'] } })
      const listedKeys = Object.keys((listed.body as { facets: Record<string, unknown> }).facets)
      expect(listedKeys).toContain('Did.pattern')
      expect(listedKeys).toContain('Did.operatorKind')
    })

    it('TG-FCT-6: the other surfaces carry their own default facets', async () => {
      const keysOf = async (surface: string): Promise<string[]> => {
        const { body } = await search({ surface })
        expect(validateSearch(body)).toBe(true)
        return Object.keys((body as { facets: Record<string, unknown> }).facets)
      }
      expect(await keysOf('Ecosystem')).toEqual(['archived', 'corporationId'])
      expect(await keysOf('Corporation')).toEqual([])
      expect(await keysOf('CredentialSchema')).toEqual(['archived', 'ecosystemId'])
      expect(await keysOf('ServiceEndpoint')).toEqual(['type'])
    })

    it('TG-FCT-3: prefix takes % and _ literally', async () => {
      const matches = async (prefix: string): Promise<string[]> => {
        const { body } = await search({ surface: 'Did', filters: { 'Did.operatorName': { prefix } } })
        return (body as { hits: { id: string }[] }).hits.map(h => h.id).sort()
      }
      expect(await matches('Acme')).toEqual([DIDS.issuer, DIDS.vs].sort())
      expect(await matches('_cme')).toEqual([])
      expect(await matches('%')).toEqual([])
    })

    it('TG-ACT-1: ECS data past its validUntil leaves groups, filters, facets and free text', async () => {
      const past = '2000-01-01T00:00:00Z'
      await db('dids').where('did', DIDS.vs).update({ sc_valid_until: past })
      await db('dids').whereIn('did', [DIDS.eco, DIDS.issuer]).update({ operator_valid_until: past })
      try {
        const all = await search({ surface: 'Did' })
        expect(validateSearch(all.body)).toBe(true)
        const b = all.body as {
          hits: { id: string; snippet: Record<string, unknown> }[]
          facets: Record<string, unknown>
        }
        const vs = b.hits.find(h => h.id === DIDS.vs)?.snippet
        expect(vs?.service).toBeNull()
        expect(vs?.operator).toBeNull()
        expect(b.hits.find(h => h.id === DIDS.issuer)?.snippet.operator).toBeNull()
        expect(b.facets['EcsCredential.ServiceCredential.type']).toEqual([])
        expect(b.facets['OrganizationCredential.countryCode']).toEqual([])

        const ids = async (payload: Record<string, unknown>): Promise<unknown[]> =>
          ((await search(payload)).body as { hits: { id: unknown }[] }).hits.map(h => h.id)
        expect(
          await ids({ surface: 'Did', filters: { 'OrganizationCredential.countryCode': 'DE' } }),
        ).toEqual([])
        expect(await ids({ surface: 'Did', filters: { 'Did.pattern': 'B' } })).toEqual([])
        expect(await ids({ surface: 'Did', freeText: 'baby' })).toEqual([])
        expect(await ids({ surface: 'Did', freeText: 'acme' })).toEqual([])
        expect(await ids({ surface: 'Did', freeText: 'plumber' })).toEqual([DIDS.issuer, DIDS.vs])
        expect(await ids({ surface: 'Ecosystem', freeText: 'banking' })).toEqual([7])
        expect(await ids({ surface: 'Ecosystem', freeText: 'acme' })).toEqual([])
        await db('dids').where('did', DIDS.eco).update({ sc_description: 'Register of supervised banks.eu' })
        expect(await ids({ surface: 'Ecosystem', freeText: 'banks' })).toEqual([7])

        const eco = await search({ surface: 'Ecosystem' })
        const card = (eco.body as { hits: { snippet: { didCard: Record<string, unknown> } }[] }).hits[0]
        expect((card?.snippet.didCard.service as { name: string }).name).toBe('EU Banking Registry')
        expect(card?.snippet.didCard.operator).toBeNull()
      } finally {
        await db('dids')
          .whereIn('did', [DIDS.vs, DIDS.eco, DIDS.issuer])
          .update({ sc_valid_until: null, operator_valid_until: null })
        await db('dids').where('did', DIDS.eco).update({ sc_description: 'Register of supervised banks' })
      }
    })
  })

  describe('snippet projection (TG-FCT-6a/6b/6c)', () => {
    it('Did defaults carry the core plus service, operator, corporation and endpoints', async () => {
      const { status, body } = await search({ surface: 'Did', freeText: 'baby shoes' })
      expect(status).toBe(200)
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: string; snippet: Record<string, unknown> }[] }).hits
      expect(hits.map(h => h.id)).toEqual([DIDS.vs])
      const snippet = hits[0]?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual([
        'corporation',
        'did',
        'endpoints',
        'isCorporation',
        'isEcosystem',
        'isTrustExpired',
        'lastObservedAtTime',
        'operator',
        'service',
        'trusted',
      ])
      expect(snippet.service).toEqual({
        pattern: 'B',
        name: 'Baby Shoes Shop',
        type: 'ECommerce',
        description: 'We sell baby shoes in Bogota',
        logoUri: 'https://vs.mock/logo.png',
        logoDigestSri: 'sha256-dGVzdA==',
      })
      expect(snippet.operator).toEqual({
        kind: 'Organization',
        name: 'Acme GmbH',
        logoUri: null,
        logoDigestSri: null,
        countryCode: 'DE',
        registryId: 'HRB-12345',
        address: 'Alexanderplatz 1, Berlin',
      })
      expect(snippet.corporation).toEqual({
        id: 42,
        deposit: '50000000uvna',
        slashedEvents: 0,
        lastSlashedAtTime: null,
        slashedValue: null,
      })
      expect(snippet.endpoints).toEqual([
        { id: 'did:mock:vs#didcomm', type: 'did-communication', serviceEndpoint: 'https://vs.mock/didcomm' },
        { id: 'did:mock:vs#mcp', type: 'MCP', serviceEndpoint: 'https://vs.mock/mcp' },
      ])
    })

    it('an empty selector leaves the Did core and its visibility flags in place', async () => {
      const { body } = await search({ surface: 'Did', includeUntrusted: true, snippet: {} })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: string; snippet: Record<string, unknown> }[] }).hits
      const snippet = hits.find(h => h.id === DIDS.corp)?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual([
        'did',
        'isCorporation',
        'isEcosystem',
        'isTrustExpired',
        'lastObservedAtTime',
        'trusted',
      ])
      expect(snippet.isCorporation).toBe(true)
      expect(snippet.trusted).toBe(false)
    })

    it('a false value behaves like an absent group', async () => {
      const { body } = await search({
        surface: 'Did',
        freeText: 'baby shoes',
        snippet: { service: false, operator: true },
      })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { snippet: Record<string, unknown> }[] }).hits
      const snippet = hits[0]?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual([
        'did',
        'isCorporation',
        'isEcosystem',
        'isTrustExpired',
        'lastObservedAtTime',
        'operator',
        'trusted',
      ])
    })

    it('Did opt-in groups list participations and presented credentials', async () => {
      const { body } = await search({
        surface: 'Did',
        freeText: 'baby shoes',
        snippet: { ecosystems: true, participations: true, credentials: true },
      })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { snippet: Record<string, unknown> }[] }).hits
      const snippet = hits[0]?.snippet ?? {}
      expect(snippet.ecosystems).toEqual([])
      expect(snippet.participations).toEqual({
        total: 2,
        ecosystemCount: 1,
        byRole: { HOLDER: 2 },
        entries: [
          {
            id: 20,
            role: 'HOLDER',
            credentialSchemaId: 100,
            schemaTitle: 'Service Credential Schema',
            ecosystemId: 7,
          },
          {
            id: 21,
            role: 'HOLDER',
            credentialSchemaId: 101,
            schemaTitle: 'Organization Credential Schema',
            ecosystemId: 7,
          },
        ],
      })
      expect(snippet.credentials).toEqual({
        total: 1,
        entries: [
          {
            id: 'urn:vtc:cert:vs',
            credentialSchemaId: 101,
            schemaTitle: 'Organization Credential Schema',
            ecosystemId: 7,
            attributes: null,
          },
        ],
      })

      await db('participants').where('id', 21).update({ state: 'FUTURE' })
      const later = await search({
        surface: 'Did',
        freeText: 'baby shoes',
        snippet: { participations: true },
      })
      await db('participants').where('id', 21).update({ state: 'ACTIVE' })
      const laterHits = (later.body as { hits: { snippet: Record<string, unknown> }[] }).hits
      expect(laterHits[0]?.snippet.participations).toEqual({
        total: 1,
        ecosystemCount: 1,
        byRole: { HOLDER: 1 },
        entries: [
          {
            id: 20,
            role: 'HOLDER',
            credentialSchemaId: 100,
            schemaTitle: 'Service Credential Schema',
            ecosystemId: 7,
          },
        ],
      })
    })

    it('Did ecosystems nest the owned schemas of the controlled Ecosystem', async () => {
      const { body } = await search({ surface: 'Did', includeUntrusted: true, snippet: { ecosystems: true } })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: string; snippet: Record<string, unknown> }[] }).hits
      const snippet = hits.find(h => h.id === DIDS.eco)?.snippet ?? {}
      expect(snippet.isEcosystem).toBe(true)
      expect(snippet.ecosystems).toEqual([
        {
          id: 7,
          archived: false,
          participants: { ISSUER: 1, HOLDER: 2 },
          schemas: [
            { id: 100, title: 'Service Credential Schema', archived: false, participants: {} },
            { id: 101, title: 'Organization Credential Schema', archived: false, participants: {} },
          ],
        },
      ])
    })

    it('a DID with nothing attached gets the documented empty forms', async () => {
      const { body } = await search({
        surface: 'Did',
        includeUntrusted: true,
        filters: { 'Did.corporationId': 42 },
        snippet: {
          service: true,
          operator: true,
          corporation: true,
          endpoints: true,
          ecosystems: true,
          participations: true,
          credentials: true,
        },
      })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: string; snippet: Record<string, unknown> }[] }).hits
      const snippet = hits.find(h => h.id === DIDS.plain)?.snippet ?? {}
      expect(snippet.service).toBeNull()
      expect(snippet.operator).toBeNull()
      expect(snippet.endpoints).toEqual([])
      expect(snippet.ecosystems).toEqual([])
      expect(snippet.participations).toEqual({ total: 0, ecosystemCount: 0, byRole: {}, entries: [] })
      expect(snippet.credentials).toEqual({ total: 0, entries: [] })
    })

    it('Ecosystem defaults and the governance and schemas opt-ins', async () => {
      const { body } = await search({ surface: 'Ecosystem' })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: number; snippet: Record<string, unknown> }[] }).hits
      expect(hits.map(h => h.id)).toEqual([7])
      const snippet = hits[0]?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual([
        'archived',
        'corporation',
        'did',
        'didCard',
        'id',
        'lastObservedAtTime',
        'stats',
      ])
      expect(snippet.corporation).toEqual({
        id: 42,
        deposit: '50000000uvna',
        slashedEvents: 0,
        lastSlashedAtTime: null,
        slashedValue: null,
      })
      expect(snippet.stats).toEqual({
        participants: { ISSUER: 1, HOLDER: 2 },
        issuedCredentials: 3,
        verifiedCredentials: 5,
      })
      expect(snippet.didCard).toEqual({
        did: DIDS.eco,
        trusted: false,
        isTrustExpired: false,
        service: {
          pattern: 'B',
          name: 'EU Banking Registry',
          type: 'TrustRegistry',
          description: 'Register of supervised banks',
          logoUri: 'https://eco.mock/logo.png',
          logoDigestSri: 'sha256-ZWNv',
        },
        operator: {
          kind: 'Organization',
          name: 'Acme GmbH',
          logoUri: null,
          logoDigestSri: null,
          countryCode: 'DE',
          registryId: 'HRB-12345',
          address: 'Alexanderplatz 1, Berlin',
        },
      })

      const optIn = await search({ surface: 'Ecosystem', snippet: { governance: true, schemas: true } })
      expect(validateSearch(optIn.body)).toBe(true)
      const extra = (optIn.body as { hits: { snippet: Record<string, unknown> }[] }).hits[0]?.snippet ?? {}
      expect(extra.governance).toEqual({
        version: 1,
        activeSince: '2023-11-14T00:00:00Z',
        documents: [{ language: 'en', url: 'https://mock.example/egf.md', digestSri: 'sha384-unfetched' }],
      })
      expect(extra.schemas).toEqual([
        { id: 100, title: 'Service Credential Schema', archived: false, participants: {} },
        { id: 101, title: 'Organization Credential Schema', archived: false, participants: {} },
      ])
    })

    it('Corporation defaults and the governance, ecosystems and dids opt-ins', async () => {
      const { body } = await search({ surface: 'Corporation' })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: number; snippet: Record<string, unknown> }[] }).hits
      expect(hits.map(h => h.id)).toEqual([42])
      const snippet = hits[0]?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual(['did', 'didCard', 'id', 'lastObservedAtTime', 'trust'])
      expect(snippet.trust).toEqual({
        policyAddress: 'verana1mockpolicyaddress',
        deposit: '50000000uvna',
        slashedEvents: 0,
        lastSlashedAtTime: null,
        slashedValue: null,
      })
      const card = snippet.didCard as { service: unknown; operator: { name: string } }
      expect(card.service).toBeNull()
      expect(card.operator.name).toBe('Verana Holdings SA')

      const optIn = await search({
        surface: 'Corporation',
        snippet: { governance: true, ecosystems: true, dids: true },
      })
      expect(validateSearch(optIn.body)).toBe(true)
      const extra = (optIn.body as { hits: { snippet: Record<string, unknown> }[] }).hits[0]?.snippet ?? {}
      expect((extra.governance as { version: number }).version).toBe(1)
      expect(extra.ecosystems).toEqual({ total: 1, entries: [{ id: 7, archived: false }] })
      const dids = extra.dids as { total: number; entries: unknown[] }
      expect(dids.total).toBe(5)
      expect(dids.entries).toContainEqual({ did: DIDS.plain, trusted: false, isTrustExpired: false })
    })

    it('CredentialSchema defaults and the body and stats opt-ins', async () => {
      const { body } = await search({ surface: 'CredentialSchema' })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: number; snippet: Record<string, unknown> }[] }).hits
      const snippet = hits.find(h => h.id === 100)?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual([
        'archived',
        'ecosystem',
        'id',
        'lastObservedAtTime',
        'schema',
      ])
      expect(snippet.schema).toEqual({
        type: 'JsonSchema',
        digestSri: DIGESTS[100],
        title: 'Service Credential Schema',
        description: 'ECS service schema for verifiable services',
      })
      expect(snippet.ecosystem).toEqual({ id: 7, archived: false })

      await db('ecosystems').where('id', 7).update({ archived: true })
      const flagged = await search({ surface: 'CredentialSchema' })
      await db('ecosystems').where('id', 7).update({ archived: false })
      const flaggedHits = (flagged.body as { hits: { id: number; snippet: Record<string, unknown> }[] }).hits
      expect(flaggedHits.find(h => h.id === 100)?.snippet.ecosystem).toEqual({ id: 7, archived: true })

      const optIn = await search({ surface: 'CredentialSchema', snippet: { body: true, stats: true } })
      expect(validateSearch(optIn.body)).toBe(true)
      const extra =
        (optIn.body as { hits: { id: number; snippet: Record<string, unknown> }[] }).hits.find(
          h => h.id === 100,
        )?.snippet ?? {}
      expect(extra.body).toEqual(JSON.parse(SCHEMA_BODIES[100] as string))
      expect(extra.stats).toEqual({ participants: {}, issuedCredentials: 0, verifiedCredentials: 0 })
    })

    it('ServiceEndpoint carries the verbatim endpoint value and the owner card', async () => {
      const { body } = await search({ surface: 'ServiceEndpoint', filters: { type: 'MCP' } })
      expect(validateSearch(body)).toBe(true)
      const hits = (body as { hits: { id: string; snippet: Record<string, unknown> }[] }).hits
      expect(hits.map(h => h.id)).toEqual(['did:mock:vs#mcp'])
      const snippet = hits[0]?.snippet ?? {}
      expect(Object.keys(snippet).sort()).toEqual([
        'didCard',
        'didId',
        'id',
        'lastObservedAtTime',
        'serviceEndpoint',
        'type',
      ])
      expect(snippet.serviceEndpoint).toBe('https://vs.mock/mcp')
      expect((snippet.didCard as { service: { name: string } }).service.name).toBe('Baby Shoes Shop')
    })

    it('an expired DID hides its endpoints and shows as expired in the owned DID entries', async () => {
      await db('dids').where('did', DIDS.issuer).update({ expires_at_time: '2000-01-01T00:00:00Z' })
      const endpoints = await search({
        surface: 'ServiceEndpoint',
        filters: { type: 'did-communication' },
        includeUntrusted: true,
      })
      const corp = await search({ surface: 'Corporation', snippet: { dids: true } })
      await db('dids').where('did', DIDS.issuer).update({ expires_at_time: '2100-01-01T00:00:00Z' })

      const endpointIds = (endpoints.body as { hits: { id: string }[] }).hits.map(h => h.id)
      expect(endpointIds).toEqual([`${DIDS.vs}#didcomm`])
      const corpHits = (corp.body as { hits: { snippet: { dids: { entries: unknown[] } } }[] }).hits
      expect(corpHits[0]?.snippet.dids.entries).toContainEqual({
        did: DIDS.issuer,
        trusted: true,
        isTrustExpired: true,
      })
    })

    it('unknown, foreign and non-boolean selector keys are rejected', async () => {
      for (const snippet of [{ nope: true }, { didCard: true }, { service: 'yes' }]) {
        const { status, body } = await search({ surface: 'Did', snippet })
        expect(status).toBe(400)
        const error = (body as { error: { code: string; message: string } }).error
        expect(error.code).toBe('INVALID_INPUT')
        expect(error.message).toContain('/snippet')
      }
    })

    it('the projection never changes totalCount or facets', async () => {
      const filters = { 'OrganizationCredential.countryCode': 'DE' }
      const plain = await search({ surface: 'Did', filters })
      const projected = await search({ surface: 'Did', filters, snippet: { participations: true } })
      expect(validateSearch(plain.body)).toBe(true)
      expect(validateSearch(projected.body)).toBe(true)
      const a = plain.body as { totalCount: number; facets: unknown }
      const b = projected.body as { totalCount: number; facets: unknown }
      expect(a.totalCount).toBeGreaterThan(0)
      expect(b.totalCount).toBe(a.totalCount)
      expect(b.facets).toEqual(a.facets)
    })

    it('a cursor minted under one selector pages on under another', async () => {
      const page1 = await search({ surface: 'Did', includeUntrusted: true, limit: 1, snippet: {} })
      expect(validateSearch(page1.body)).toBe(true)
      const b1 = page1.body as { hits: { id: string }[]; cursor: string }
      const page2 = await search({
        surface: 'Did',
        includeUntrusted: true,
        limit: 1,
        cursor: b1.cursor,
        snippet: { service: true },
      })
      expect(page2.status).toBe(200)
      expect(validateSearch(page2.body)).toBe(true)
      const b2 = page2.body as { hits: { id: string }[] }
      expect(b2.hits[0]?.id).not.toBe(b1.hits[0]?.id)
    })
  })

  describe('docs', () => {
    it('the served OpenAPI document carries the snippet schemas and a selector example', async () => {
      const res = await fetch(`${baseUrl}/docs/openapi.json`)
      expect(res.status).toBe(200)
      const doc = (await res.json()) as {
        components: { schemas: Record<string, unknown> }
        paths: Record<string, unknown>
      }
      expect(doc.components.schemas).toHaveProperty('search_request_SnippetSelectorDid')
      expect(doc.components.schemas).toHaveProperty('search_response_DidCard')
      expect(doc.paths['/v4/graph/search']).toHaveProperty(
        ['post', 'requestBody', 'content', 'application/json', 'examples', 'snippetDid', 'value', 'snippet'],
        { service: true, operator: true, participations: true, credentials: true },
      )
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

  describe('participant lifecycle in search', () => {
    it('TG-FCT-3: a non-ACTIVE participant never matches faceted-search joins', async () => {
      const before = await search({
        surface: 'Did',
        filters: { 'Participant.role': { eq: 'ISSUER' }, 'Participant.credentialSchemaId': { eq: 101 } },
      })
      expect((before.body as { hits: { id: string }[] }).hits.map(h => h.id)).toContain(DIDS.issuer)

      const snap = structuredClone(issuerSnapshot(true))
      const p11 = snap.participations?.find(p => p.id === 11)
      if (p11) p11.state = 'EXPIRED'
      mock.world.snapshots.get(DIDS.issuer)?.set(150, snap)
      mock.pushBlock(block(150, [{ did: DIDS.issuer, participations: true }]))
      await waitFor(async () => (await db('participants').where('id', 11).first())?.state === 'EXPIRED')

      const after = await search({
        surface: 'Did',
        filters: { 'Participant.role': { eq: 'ISSUER' }, 'Participant.credentialSchemaId': { eq: 101 } },
      })
      expect((after.body as { hits: { id: string }[] }).hits.map(h => h.id)).not.toContain(DIDS.issuer)

      mock.world.snapshots.get(DIDS.issuer)?.set(151, issuerSnapshot(true))
      mock.pushBlock(block(151, [{ did: DIDS.issuer, participations: true }]))
      await waitFor(async () => (await db('participants').where('id', 11).first())?.state === 'ACTIVE')
    })
  })
})
