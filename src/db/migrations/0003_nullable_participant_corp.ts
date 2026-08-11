import { Knex } from 'knex'

// Companion to 0002: Participants exist on DIDs no Corporation has adopted as its own did
// (an Ecosystem DID holding the ECOSYSTEM-root entry), so the envelope-derived corporationId
// is null there. Store the null; the trust-refresh sweep fills it in once upstream resolves.
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE participants ALTER COLUMN corporation_id DROP NOT NULL')
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE participants ALTER COLUMN corporation_id SET NOT NULL')
}
