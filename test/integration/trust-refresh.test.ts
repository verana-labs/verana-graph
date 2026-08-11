import { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dereferencer } from '../../src/deref/deref'
import { IndexerRestClient } from '../../src/indexer/rest'
import { IngestOrchestrator } from '../../src/ingest/orchestrator'
import { createLogger } from '../../src/util/logger'
import { buildWorld, DIDS } from '../harness/fixture'
import { MockIndexer } from '../harness/mock-indexer'
import { freshDb, testConfig, waitFor } from '../harness/setup'

const log = createLogger('silent')

// Regression for the live-indexer finding: with a short expiry horizon and no chain activity,
// every DID ages past expiresAtTime and TG-FCT-2 gates the whole discovery surface to empty.
// The spec has no refresh mechanism; the sweep is our documented deviation.
describe('trust-expiry refresh sweep', () => {
  let db: Knex
  let mock: MockIndexer
  let orchestrator: IngestOrchestrator

  beforeEach(async () => {
    db = await freshDb()
    const world = buildWorld()
    const stale = new Date(Date.now() - 3600_000).toISOString()
    for (const versions of world.snapshots.values()) {
      for (const snap of versions.values()) if (snap.expiresAtTime !== null) snap.expiresAtTime = stale
    }
    mock = new MockIndexer(world)
    await mock.start()
    const config = testConfig(mock.baseUrl, mock.wsUrl)
    const rest = new IndexerRestClient(config.indexerBaseUrl)
    const deref = new Dereferencer(db, rest, config, log)
    orchestrator = new IngestOrchestrator(db, rest, deref, config.indexerWsUrl, log, 0, 200)
    await orchestrator.start()
    await waitFor(async () => (await db('ingestion_state').where('id', 1).first())?.last_applied_block === 99)
  })

  afterEach(async () => {
    orchestrator.stop()
    await mock.stop()
    await db.destroy()
  })

  it('re-resolves expired DIDs and lifts the trust-expiry gate', async () => {
    const expiredBefore = Number(
      (await db('dids').where('expires_at_time', '<', new Date().toISOString()).count('* as n').first())?.n,
    )
    expect(expiredBefore).toBe(5)

    // upstream now reports a future horizon, as a live indexer does on re-evaluation
    const future = new Date(Date.now() + 3600_000).toISOString()
    for (const versions of mock.world.snapshots.values()) {
      for (const snap of versions.values()) if (snap.expiresAtTime !== null) snap.expiresAtTime = future
    }

    const refreshed = await orchestrator.refreshExpiredTrust()
    expect(refreshed).toBe(5)

    const expiredAfter = Number(
      (await db('dids').where('expires_at_time', '<', new Date().toISOString()).count('* as n').first())?.n,
    )
    expect(expiredAfter).toBe(0)
    // IDX-VT-EVAL-2: a null horizon never expires, so the sweep never touches it
    expect((await db('dids').where('did', DIDS.orphan).first()).expires_at_time).toBeNull()
    const vs = await db('dids').where('did', DIDS.vs).first()
    expect(new Date(vs.expires_at_time).getTime()).toBeGreaterThan(Date.now())
  })

  it('is a no-op when nothing has expired', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString()
    await db('dids').update({ expires_at_time: future })
    expect(await orchestrator.refreshExpiredTrust()).toBe(0)
  })
})
