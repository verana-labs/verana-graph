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
  // TG-IDX-2 structured indexes for the operative name fields; text_pattern_ops so the
  // prefix operator of TG-FCT-3 can use them too
  for (const col of ['sc_name', 'org_name', 'persona_name']) {
    await knex.raw(`CREATE INDEX dids_${col}_idx ON dids (${col} text_pattern_ops)`)
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const col of ['sc_name', 'org_name', 'persona_name']) {
    await knex.raw(`DROP INDEX IF EXISTS dids_${col}_idx`)
  }
  await knex.schema.alterTable('dids', table => {
    table.dropColumn('sc_logo_uri')
    table.dropColumn('sc_logo_digest_sri')
    table.dropColumn('org_logo_uri')
    table.dropColumn('org_logo_digest_sri')
    table.dropColumn('persona_avatar_uri')
    table.dropColumn('persona_avatar_digest_sri')
  })
}
