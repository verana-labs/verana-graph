import type { Knex } from 'knex'

// spec v4-draft3 (IDX-VT-EVAL-2): expiresAtTime is null when no trust-flipping boundary exists
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dids', table => {
    table.timestamp('expires_at_time', { useTz: true }).nullable().alter()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dids', table => {
    table.timestamp('expires_at_time', { useTz: true }).notNullable().alter()
  })
}
