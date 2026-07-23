import { Knex } from 'knex'

// Live-indexer finding: the trust envelope's corporationId is null for DIDs (e.g. Ecosystem
// DIDs) not yet adopted by any Corporation at that block. The spec claims the field is always
// present; reality makes it transient. Filed upstream; the graph tolerates null.
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE dids ALTER COLUMN corporation_id DROP NOT NULL')
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE dids ALTER COLUMN corporation_id SET NOT NULL')
}
