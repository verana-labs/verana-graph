import type { Knex } from 'knex'

const PREFIX_COLUMNS = ['org_legal_jurisdiction', 'persona_jurisdiction']

// pattern B takes the ServiceCredential issuer's identity, as in 0008
const OPERATIVE = `
  operative as (
    select d.did,
      case when d.pattern = 'B' then i.did_id else d.did end as operative_did
    from dids d
    left join ecs_credentials sc
      on sc.subject_did = d.did and sc.ecs_schema = 'ServiceCredential'
    left join participants i on i.id = sc.issuer_participant_id
  )`

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dids', table => {
    table.timestamp('sc_valid_until', { useTz: true }).nullable()
    table.timestamp('operator_valid_until', { useTz: true }).nullable()
  })
  // LIKE prefix under a non-C collation needs text_pattern_ops, which still serves eq and in
  for (const col of PREFIX_COLUMNS) {
    await knex.raw(`DROP INDEX dids_${col}_index`)
    await knex.raw(`CREATE INDEX dids_${col}_index ON dids (${col} text_pattern_ops)`)
  }

  await knex.raw(`
    update dids d set sc_valid_until = c.valid_until
    from ecs_credentials c
    where c.subject_did = d.did
      and c.ecs_schema = 'ServiceCredential'
      and c.valid_until is not null
  `)
  await knex.raw(`
    with ${OPERATIVE}
    update dids d set operator_valid_until = c.valid_until
    from operative o, ecs_credentials c
    where o.did = d.did
      and c.subject_did = o.operative_did
      and c.ecs_schema = d.operator_kind || 'Credential'
      and c.valid_until is not null
  `)
}

export async function down(knex: Knex): Promise<void> {
  for (const col of PREFIX_COLUMNS) {
    await knex.raw(`DROP INDEX dids_${col}_index`)
    await knex.raw(`CREATE INDEX dids_${col}_index ON dids (${col})`)
  }
  await knex.schema.alterTable('dids', table => {
    table.dropColumn('sc_valid_until')
    table.dropColumn('operator_valid_until')
  })
}
