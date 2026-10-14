import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('schema_load_retries', table => {
    table.bigInteger('schema_id').primary()
    table.jsonb('request').notNullable()
    table.integer('attempts').notNullable()
    table.timestamp('next_attempt_at', { useTz: true }).notNullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('schema_load_retries')
}
