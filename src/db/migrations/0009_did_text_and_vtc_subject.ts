import type { Knex } from 'knex'

const ROLES = ['HOLDER', 'ISSUER', 'VERIFIER', 'ISSUER_GRANTOR', 'VERIFIER_GRANTOR', 'ECOSYSTEM']
const DID_TEXT = `nullif(concat_ws(' ', d.sc_name, d.sc_description, coalesce(d.org_name, d.persona_name)), '')`
const TABLES = [
  ['ecosystems', 'egf_text'],
  ['corporations', 'cgf_text'],
] as const

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('vtcs', t => {
    t.jsonb('credential_subject').nullable()
  })
  for (const [table, gf] of TABLES) {
    await knex.schema.alterTable(table, t => {
      t.text('did_text').nullable()
    })
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN search_vec`)
    await knex.raw(`
      ALTER TABLE ${table} ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(did_text, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(${gf}, '')), 'D')
      ) STORED`)
    await knex.raw(`CREATE INDEX ${table}_search_vec_idx ON ${table} USING GIN (search_vec)`)
    await knex.raw(`UPDATE ${table} t SET did_text = ${DID_TEXT} FROM dids d WHERE d.did = t.did`)
  }
  await knex.raw('CREATE INDEX dids_pattern_idx ON dids (pattern)')
  for (const role of ROLES) {
    await knex.raw(
      `CREATE INDEX ecosystems_participants_${role.toLowerCase()}_idx ON ecosystems (((participants->>'${role}')::bigint))`,
    )
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const role of ROLES)
    await knex.raw(`DROP INDEX IF EXISTS ecosystems_participants_${role.toLowerCase()}_idx`)
  await knex.raw('DROP INDEX IF EXISTS dids_pattern_idx')
  for (const [table, gf] of TABLES) {
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN search_vec`)
    await knex.raw(`
      ALTER TABLE ${table} ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(${gf}, '')), 'D')
      ) STORED`)
    await knex.raw(`CREATE INDEX ${table}_search_vec_idx ON ${table} USING GIN (search_vec)`)
    await knex.schema.alterTable(table, t => {
      t.dropColumn('did_text')
    })
  }
  await knex.schema.alterTable('vtcs', t => {
    t.dropColumn('credential_subject')
  })
}
