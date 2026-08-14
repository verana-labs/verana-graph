import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ecs_credentials', table => {
    table.text('digest_jcs').nullable()
    table.timestamp('issued_at_time', { useTz: true }).nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ecs_credentials', table => {
    table.dropColumn('digest_jcs')
    table.dropColumn('issued_at_time')
  })
}
