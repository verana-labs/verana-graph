import { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dereferencer } from '../../src/deref/deref'
import type { DidDocResolver, DidDocumentLike } from '../../src/deref/vpVerify'
import { IndexerRestClient } from '../../src/indexer/rest'
import { IngestOrchestrator } from '../../src/ingest/orchestrator'
import { createLogger } from '../../src/util/logger'
import { buildWorld, DIDS } from '../harness/fixture'
import { block, MockIndexer } from '../harness/mock-indexer'
import { freshDb, testConfig, waitFor } from '../harness/setup'
import { makeHolder, signVp } from '../harness/vp'

const log = createLogger('silent')
const SUBJECT = { id: DIDS.vs, degreeType: 'MSc', field: 'Plumbing' }

describe('VP body fetch (TG-DEREF-3)', () => {
  let db: Knex
  let mock: MockIndexer
  let orchestrator: IngestOrchestrator
  let deref: Dereferencer
  let holder: Awaited<ReturnType<typeof makeHolder>>
  let doc: DidDocumentLike
  let world: ReturnType<typeof buildWorld>

  beforeEach(async () => {
    db = await freshDb()
    holder = await makeHolder(DIDS.vs)
    doc = holder.doc
    const vp = await signVp(holder.key, DIDS.vs, {
      verifiableCredential: [{ id: 'urn:vtc:cert:vs', credentialSubject: SUBJECT }],
    })
    world = buildWorld()
    world.vpBodies = new Map([['vp1.json', vp]])
    mock = new MockIndexer(world)
    await mock.start()
    const vs = mock.world.snapshots.get(DIDS.vs)?.get(0)
    const presentation = vs?.presentations?.[0]
    if (presentation) presentation.id = `${mock.baseUrl}/vp/vp1.json`
  })

  afterEach(async () => {
    orchestrator.stop()
    await mock.stop()
    await db.destroy()
  })

  async function bootstrapped(resolve: DidDocResolver = async () => doc): Promise<void> {
    const config = { ...testConfig(mock.baseUrl, mock.wsUrl), fetchVpBodies: true }
    const rest = new IndexerRestClient(config.indexerBaseUrl)
    deref = new Dereferencer(db, rest, config, log, resolve)
    orchestrator = new IngestOrchestrator(db, rest, deref, config.indexerWsUrl, log)
    await orchestrator.start()
    await waitFor(async () => (await db('ingestion_state').where('id', 1).first())?.last_applied_block === 99)
  }

  it('TG-DEREF-3: a verified VP body persists the credential subject', async () => {
    await bootstrapped()
    const vtc = await db('vtcs').where('id', 'urn:vtc:cert:vs').first()
    expect(vtc.credential_subject).toEqual(SUBJECT)
    expect(vtc.subject_text).toBe('MSc Plumbing')
    const vs = await db('dids').where('did', DIDS.vs).first()
    expect(vs.vtc_text).toContain('Plumbing')
  })

  it('TG-DEREF-4: one fetch per URL and block', async () => {
    await bootstrapped()
    const presentations = mock.world.snapshots.get(DIDS.vs)?.get(0)?.presentations ?? []
    await deref.fetchVpBodies(DIDS.vs, presentations, 99)
    expect(mock.vpHits).toHaveLength(1)
  })

  it('TG-DEREF-3: claims without text still persist the credential subject', async () => {
    const subject = { id: DIDS.vs, score: 42 }
    world.vpBodies?.set(
      'vp1.json',
      await signVp(holder.key, DIDS.vs, {
        verifiableCredential: [{ id: 'urn:vtc:cert:vs', credentialSubject: subject }],
      }),
    )
    await bootstrapped()
    const vtc = await db('vtcs').where('id', 'urn:vtc:cert:vs').first()
    expect(vtc.credential_subject).toEqual(subject)
    expect(vtc.subject_text).toBeNull()
  })

  it('TG-DEREF-3: a resolve without a presentations change does not refetch', async () => {
    await bootstrapped()
    mock.pushBlock(block(101, [{ did: DIDS.vs, services: true }]))
    mock.pushBlock(block(102, []))
    await waitFor(async () => (await db('ingestion_state').first())?.last_applied_block === 102)
    expect(mock.vpHits).toHaveLength(1)

    mock.pushBlock(block(103, [{ did: DIDS.vs, presentations: true }]))
    await waitFor(async () => mock.vpHits.length === 2)
  })

  it('an unverifiable VP writes nothing', async () => {
    await bootstrapped(async () => null)
    expect(mock.vpHits).toHaveLength(1)
    const vtc = await db('vtcs').where('id', 'urn:vtc:cert:vs').first()
    expect(vtc.credential_subject).toBeNull()
    expect(vtc.subject_text).toBeNull()
  })
})
