import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ecs_credentials', table => {
    table.dropPrimary()
    table.primary(['subject_did', 'id'])
  })
}

export async function down(knex: Knex): Promise<void> {
  // the id-only key holds one holder per id: keep the latest observed
  await knex.raw(`
    DELETE FROM ecs_credentials a USING ecs_credentials b
    WHERE a.id = b.id
      AND (a.last_observed_at_block, a.subject_did) < (b.last_observed_at_block, b.subject_did)`)
  await knex.schema.alterTable('ecs_credentials', table => {
    table.dropPrimary()
    table.primary(['id'])
  })
}
