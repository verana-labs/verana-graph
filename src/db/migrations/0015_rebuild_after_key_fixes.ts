import type { Knex } from 'knex'

// every table is derived from the indexer: an empty ingestion_state re-bootstraps on the next start
const TABLES = [
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
  'schema_load_retries',
]

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`TRUNCATE ${TABLES.join(', ')}`)
}

export async function down(): Promise<void> {}
