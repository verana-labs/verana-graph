import { Knex } from 'knex'
import { Config } from '../../src/config.js'
import { createDb } from '../../src/db/knex.js'

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://verana:verana@localhost:5433/verana_graph'

export function testConfig(indexerBaseUrl: string, wsUrl: string): Config {
  return {
    databaseUrl: TEST_DATABASE_URL,
    indexerBaseUrl,
    indexerWsUrl: wsUrl,
    port: 0,
    fetchGfDocBodies: false,
    fetchVpBodies: false,
    gapCoalesceThreshold: 1000,
    bpsMaxBufferedBytes: 1024 * 1024,
    gateServiceEndpoints: false,
    // sweeps are exercised by an explicit test, never on a timer during e2e
    trustRefreshIntervalMs: 0,
    trustRefreshBatch: 200,
    logLevel: 'silent',
  }
}

export async function freshDb(): Promise<Knex> {
  const db = createDb(TEST_DATABASE_URL)
  await db.migrate.latest()
  const tables = [
    'ingestion_state',
    'dids',
    'corporations',
    'ecosystems',
    'credential_schemas',
    'service_endpoints',
    'linked_vps',
    'ecs_credentials',
    'vtcs',
    'lvp_vtcs',
    'participants',
    'gf_doc_bodies',
  ]
  await db.raw(`TRUNCATE ${tables.join(', ')}`)
  return db
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('waitFor timed out')
}
