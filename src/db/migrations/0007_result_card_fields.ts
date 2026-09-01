import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dids', table => {
    table.text('sc_logo_uri').nullable()
    table.text('sc_logo_digest_sri').nullable()
    table.text('org_logo_uri').nullable()
    table.text('org_logo_digest_sri').nullable()
    table.text('persona_avatar_uri').nullable()
    table.text('persona_avatar_digest_sri').nullable()
  })
  // TG-IDX-2 index for the operative name. It matches the coalesce the Did.operatorName
  // filter uses, so it serves both eq and prefix; a plain per-column index cannot.
  await knex.raw(
    `CREATE INDEX dids_operator_name_idx ON dids ((coalesce(org_name, persona_name)) text_pattern_ops)`,
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS dids_operator_name_idx')
  await knex.schema.alterTable('dids', table => {
    table.dropColumn('sc_logo_uri')
    table.dropColumn('sc_logo_digest_sri')
    table.dropColumn('org_logo_uri')
    table.dropColumn('org_logo_digest_sri')
    table.dropColumn('persona_avatar_uri')
    table.dropColumn('persona_avatar_digest_sri')
  })
}
