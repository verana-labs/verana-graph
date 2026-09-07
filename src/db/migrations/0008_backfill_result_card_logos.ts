import type { Knex } from 'knex'

// 0007 added the logo columns without a backfill, and a DID row is rewritten only when the
// indexer publishes a change for it, so every row written before 0007 ran kept NULL for good.
// The subjects were already stored in ecs_credentials, so the values are recoverable here.
// `operative` mirrors operativeIdentity(): pattern B takes the ServiceCredential issuer's
// identity, everything else takes the DID's own.
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
  await knex.raw(`
    update dids d set
      sc_logo_uri = c.credential_subject ->> 'logoUri',
      sc_logo_digest_sri = c.credential_subject ->> 'logoDigestSri'
    from ecs_credentials c
    where c.subject_did = d.did
      and c.ecs_schema = 'ServiceCredential'
      and d.sc_logo_uri is null
  `)

  await knex.raw(`
    with ${OPERATIVE}
    update dids d set
      org_logo_uri = c.credential_subject ->> 'logoUri',
      org_logo_digest_sri = c.credential_subject ->> 'logoDigestSri'
    from operative o
    join ecs_credentials c
      on c.subject_did = o.operative_did and c.ecs_schema = 'OrganizationCredential'
    where o.did = d.did
      and d.operator_kind = 'Organization'
      and d.org_logo_uri is null
  `)

  await knex.raw(`
    with ${OPERATIVE}
    update dids d set
      persona_avatar_uri = c.credential_subject ->> 'avatarUri',
      persona_avatar_digest_sri = c.credential_subject ->> 'avatarDigestSri'
    from operative o
    join ecs_credentials c
      on c.subject_did = o.operative_did and c.ecs_schema = 'PersonaCredential'
    where o.did = d.did
      and d.operator_kind = 'Persona'
      and d.persona_avatar_uri is null
  `)
}

export async function down(): Promise<void> {
  // a backfill of columns 0007 owns; 0007's down drops them
}
