import { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { participantRef } from '../../src/api/refs'
import { Dereferencer } from '../../src/deref/deref'
import { IndexerRestClient } from '../../src/indexer/rest'
import { IngestOrchestrator } from '../../src/ingest/orchestrator'
import { createLogger } from '../../src/util/logger'
import { buildWorld, DIDS, issuerSnapshot, vsSnapshot } from '../harness/fixture'
import { block, MockIndexer } from '../harness/mock-indexer'
import { freshDb, testConfig, waitFor } from '../harness/setup'

const log = createLogger('silent')

describe('ingestion lifecycle', () => {
  let db: Knex
  let mock: MockIndexer
  let orchestrator: IngestOrchestrator

  beforeEach(async () => {
    db = await freshDb()
    mock = new MockIndexer(buildWorld())
    await mock.start()
    const config = testConfig(mock.baseUrl, mock.wsUrl)
    const rest = new IndexerRestClient(config.indexerBaseUrl)
    const deref = new Dereferencer(db, rest, config, log)
    orchestrator = new IngestOrchestrator(db, rest, deref, config.indexerWsUrl, log)
  })

  afterEach(async () => {
    orchestrator.stop()
    await mock.stop()
    await db.destroy()
  })

  async function bootstrapped(): Promise<void> {
    await orchestrator.start()
    await waitFor(async () => {
      const row = await db('ingestion_state').where('id', 1).first()
      return row?.last_applied_block === 99
    })
    // schema bodies load post-commit; both must land for the snapshot to be complete
    await waitFor(async () => {
      const n = await db('credential_schemas').count('* as n').first()
      return Number(n?.n) === 2
    })
  }

  it('TG-INGEST-3: bootstrap anchors on subscribed.block, not ready.block', async () => {
    const world = buildWorld()
    world.blocks.push({ type: 'block', block: 104, blockTime: new Date().toISOString(), changes: [] })
    await mock.stop()
    mock = new MockIndexer(world)
    await mock.start()
    const config = testConfig(mock.baseUrl, mock.wsUrl)
    const rest = new IndexerRestClient(config.indexerBaseUrl)
    const deref = new Dereferencer(db, rest, config, log)
    orchestrator = new IngestOrchestrator(db, rest, deref, config.indexerWsUrl, log)

    await orchestrator.start()
    await waitFor(async () => {
      const row = await db('ingestion_state').where('id', 1).first()
      return row?.last_applied_block === 104
    })
  })

  it('TG-INGEST-3: without the subscribed acknowledgement the bootstrap never starts', async () => {
    mock.suppressAck = true
    await orchestrator.start()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await db('ingestion_state').where('id', 1).first()).toBeUndefined()
  })

  it('TG-INGEST-3: bootstrap materialises the full snapshot at B-1', async () => {
    await bootstrapped()

    expect(Number((await db('dids').count('* as n').first())?.n)).toBe(6)
    const vs = await db('dids').where('did', DIDS.vs).first()
    expect(vs.trusted).toBe(true)
    expect(vs.pattern).toBe('B')
    expect(vs.operator_kind).toBe('Organization')
    expect(vs.org_country_code).toBe('DE')
    expect(vs.sc_name).toBe('Baby Shoes Shop')
    expect(vs.service_types).toEqual(['did-communication', 'MCP'])

    const plain = await db('dids').where('did', DIDS.plain).first()
    expect(plain.trusted).toBe(false)
    expect(plain.pattern).toBeNull()

    const orphan = await db('dids').where('did', DIDS.orphan).first()
    expect(orphan.corporation_id).toBeNull()
    expect(orphan.expires_at_time).toBeNull()

    expect((await db('corporations').where('id', 42).first()).did).toBe(DIDS.corp)
    expect((await db('ecosystems').where('id', 7).first()).did).toBe(DIDS.eco)

    // TG-DEREF-2: bodies loaded once, digest-validated, title extracted
    const schema100 = await db('credential_schemas').where('id', 100).first()
    expect(schema100.title).toBe('Service Credential Schema')

    expect(Number((await db('participants').count('* as n').first())?.n)).toBe(6)
    expect(Number((await db('vtcs').count('* as n').first())?.n)).toBe(1)

    // the schema-text denorm slot filled after the async schema load
    await waitFor(async () => {
      const row = await db('dids').where('did', DIDS.vs).first()
      return Boolean(row.schema_text?.includes('Organization Credential Schema'))
    })
  })

  it('TG-INGEST-4: trust-only envelopes apply inline without a resolve call', async () => {
    await bootstrapped()
    const before = mock.resolveCalls.length
    mock.pushBlock(
      block(100, [
        {
          did: DIDS.vs,
          trust: {
            trusted: false,
            evaluatedAtTime: '2023-11-15T00:00:00Z',
            evaluatedAtBlock: 100,
            expiresAtTime: '2100-01-01T00:00:00Z',
            corporationId: 42,
          },
        },
      ]),
    )
    await waitFor(async () => (await db('dids').where('did', DIDS.vs).first()).trusted === false)
    expect(mock.resolveCalls.length).toBe(before)
    expect((await db('ingestion_state').first()).last_applied_block).toBe(100)
  })

  it('TG-ACT-1: a participant absent from the response is hard-deleted on reconcile', async () => {
    await bootstrapped()
    expect(await db('participants').where('id', 11).first()).toBeTruthy()
    mock.world.snapshots.get(DIDS.issuer)?.set(101, issuerSnapshot(false))
    mock.pushBlock(block(101, [{ did: DIDS.issuer, participations: true }]))
    await waitFor(async () => !(await db('participants').where('id', 11).first()))
    expect(await db('participants').where('id', 10).first()).toBeTruthy()
  })

  it('TG-ACT-1: a participant that leaves ACTIVE is retained with its state while referenced', async () => {
    await bootstrapped()
    const snap = structuredClone(issuerSnapshot(true))
    const p11 = snap.participations?.find(p => p.id === 11)
    if (p11) p11.state = 'EXPIRED'
    mock.world.snapshots.get(DIDS.issuer)?.set(101, snap)
    mock.pushBlock(block(101, [{ did: DIDS.issuer, participations: true }]))

    await waitFor(async () => (await db('participants').where('id', 11).first())?.state === 'EXPIRED')
    const row = await db('participants').where('id', 11).first()
    expect(participantRef(row).state).toBe('EXPIRED')
  })

  it('TG-ACT-1: losing the last reference cascades the whole inactive subtree', async () => {
    await bootstrapped()
    const issuerSnap = structuredClone(issuerSnapshot(true))
    for (const id of [11, 12]) {
      const entry = issuerSnap.participations?.find(p => p.id === id)
      if (entry) entry.state = 'EXPIRED'
    }
    issuerSnap.ecsCredentials = []
    mock.world.snapshots.get(DIDS.issuer)?.set(101, issuerSnap)
    mock.pushBlock(block(101, [{ did: DIDS.issuer, participations: true }]))

    await waitFor(async () => (await db('participants').where('id', 11).first())?.state === 'EXPIRED')
    expect(await db('vtcs').where('issuer_participant_id', 11).first()).toBeTruthy()

    const vsSnap = structuredClone(vsSnapshot(false))
    vsSnap.participations = vsSnap.participations?.filter(p => p.id !== 21)
    mock.world.snapshots.get(DIDS.vs)?.set(102, vsSnap)
    mock.pushBlock(block(102, [{ did: DIDS.vs, participations: true, presentations: true }]))

    await waitFor(async () => !(await db('participants').where('id', 11).first()))
    expect(await db('participants').where('id', 12).first()).toBeUndefined()
    expect(await db('participants').where('id', 10).first()).toBeTruthy()
  })

  it('TG-ACT-1: an unreferenced non-ACTIVE entry is never persisted', async () => {
    await bootstrapped()
    const snap = structuredClone(issuerSnapshot(true))
    snap.participations?.push({
      id: 99,
      vsOperator: 'verana1issueroperator',
      role: 'ISSUER',
      state: 'FUTURE',
      credentialSchemaId: 100,
      ecosystemId: 7,
      weight: '1uvna',
      validatorParticipantId: 1,
    })
    mock.world.snapshots.get(DIDS.issuer)?.set(101, snap)
    mock.pushBlock(block(101, [{ did: DIDS.issuer, participations: true }]))

    await waitFor(async () => (await db('ingestion_state').first())?.last_applied_block === 101)
    expect(await db('participants').where('id', 99).first()).toBeUndefined()
  })

  it('TG-ACT-2: archive flips are observed in both directions and never delete', async () => {
    await bootstrapped()
    const { ecoSnapshot } = await import('../harness/fixture')
    mock.world.snapshots.get(DIDS.eco)?.set(102, ecoSnapshot(true))
    mock.pushBlock(block(102, [{ did: DIDS.eco, ecosystems: true }]))
    await waitFor(async () => (await db('credential_schemas').where('id', 101).first())?.archived === true)

    mock.world.snapshots.get(DIDS.eco)?.set(103, ecoSnapshot(false))
    mock.pushBlock(block(103, [{ did: DIDS.eco, ecosystems: true }]))
    await waitFor(async () => (await db('credential_schemas').where('id', 101).first())?.archived === false)
  })

  it('TG-ACT-1: removing the last referencing VP garbage-collects the orphan Vtc', async () => {
    await bootstrapped()
    mock.world.snapshots.get(DIDS.vs)?.set(104, vsSnapshot(false))
    mock.pushBlock(block(104, [{ did: DIDS.vs, presentations: true }]))
    await waitFor(async () => Number((await db('vtcs').count('* as n').first())?.n) === 0)
    expect(Number((await db('linked_vps').count('* as n').first())?.n)).toBe(0)
  })

  it('TG-INGEST-5: a live gap is recovered via listChanges with identical terminal state', async () => {
    await bootstrapped()
    // blocks 100-101 never arrive over the WS; block 102 exposes the gap
    mock.suppressWs = true
    mock.pushBlock(block(100, [{ did: DIDS.issuer, participations: true }]))
    mock.world.snapshots.get(DIDS.issuer)?.set(101, issuerSnapshot(false))
    mock.pushBlock(block(101, [{ did: DIDS.issuer, participations: true }]))
    mock.suppressWs = false
    mock.pushBlock(block(102, []))

    await waitFor(async () => (await db('ingestion_state').first()).last_applied_block === 102)
    expect(await db('participants').where('id', 11).first()).toBeFalsy()
  })

  it('reconnect after a dropped subscription resumes from lastAppliedBlock', async () => {
    await bootstrapped()
    mock.dropConnections()
    mock.suppressWs = true
    mock.world.snapshots.get(DIDS.issuer)?.set(105, issuerSnapshot(false))
    mock.pushBlock(block(105, [{ did: DIDS.issuer, participations: true }]))
    mock.suppressWs = false
    await waitFor(async () => (await db('ingestion_state').first()).last_applied_block >= 105, 20_000)
    expect(await db('participants').where('id', 11).first()).toBeFalsy()
  })
})
