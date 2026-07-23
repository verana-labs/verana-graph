import { Knex } from 'knex'

const FRESHNESS = (table: Knex.CreateTableBuilder) => {
  table.timestamp('last_observed_at_time', { useTz: true }).notNullable()
  table.bigInteger('last_observed_at_block').notNullable()
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ingestion_state', table => {
    table.integer('id').primary().checkIn(['1'])
    table.bigInteger('last_applied_block').notNullable()
    table.timestamp('last_block_time', { useTz: true }).notNullable()
  })

  await knex.schema.createTable('dids', table => {
    table.text('did').primary()
    table.boolean('trusted').notNullable()
    table.timestamp('evaluated_at_time', { useTz: true }).notNullable()
    table.bigInteger('evaluated_at_block').notNullable()
    // TG-ACT-3: trust-expiry is a query-time predicate on this column, never a deletion
    table.timestamp('expires_at_time', { useTz: true }).notNullable()
    table.bigInteger('corporation_id').notNullable()
    // nullable: pattern is underivable for untrusted DIDs (verana-spec issue filed)
    table.text('pattern').nullable().checkIn(['A', 'B'])
    table.specificType('service_types', 'text[]').notNullable().defaultTo('{}')
    table.text('operator_kind').nullable().checkIn(['Organization', 'Persona'])
    // TG-FCT-4 free-text slots, denormalised at reconcile time
    table.text('sc_name').nullable()
    table.text('sc_type').nullable()
    table.text('sc_description').nullable()
    table.integer('min_age').nullable()
    table.text('org_name').nullable()
    table.text('org_address').nullable()
    table.text('org_country_code').nullable()
    table.text('org_legal_jurisdiction').nullable()
    table.text('org_organization_kind').nullable()
    table.text('org_lei').nullable()
    table.text('org_registry_id').nullable()
    table.text('persona_name').nullable()
    table.text('persona_description').nullable()
    table.text('persona_country_code').nullable()
    table.text('persona_jurisdiction').nullable()
    table.text('schema_text').nullable()
    table.text('vtc_text').nullable()
    FRESHNESS(table)
    table.index(['corporation_id'])
    table.index(['trusted'])
    table.index(['expires_at_time'])
    table.index(['operator_kind'])
    table.index(['sc_type'])
    table.index(['org_country_code'])
    table.index(['org_legal_jurisdiction'])
    table.index(['org_organization_kind'])
    table.index(['org_lei'])
    table.index(['org_registry_id'])
    table.index(['persona_country_code'])
    table.index(['persona_jurisdiction'])
    table.index(['min_age'])
  })
  await knex.raw(`
    ALTER TABLE dids ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(sc_name, '') || ' ' || coalesce(sc_description, '')), 'A') ||
      setweight(to_tsvector('simple',
        coalesce(org_name, '') || ' ' || coalesce(org_address, '') || ' ' ||
        coalesce(persona_name, '') || ' ' || coalesce(persona_description, '') || ' ' ||
        coalesce(vtc_text, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(schema_text, '')), 'C')
    ) STORED
  `)
  await knex.raw('CREATE INDEX dids_search_vec_idx ON dids USING GIN (search_vec)')
  await knex.raw('CREATE INDEX dids_service_types_idx ON dids USING GIN (service_types)')

  await knex.schema.createTable('corporations', table => {
    table.bigInteger('id').primary()
    table.text('policy_address').nullable()
    table.text('did').nullable()
    table.text('deposit').nullable()
    table.specificType('deposit_amount', 'NUMERIC(38,0)').nullable()
    table.timestamp('last_slashed_at_time', { useTz: true }).nullable()
    table.integer('slashed_events').notNullable().defaultTo(0)
    table.text('slashed_value').nullable()
    table.jsonb('cgf').nullable()
    table.text('cgf_text').nullable()
    FRESHNESS(table)
    table.index(['did'])
    table.index(['deposit_amount'])
    table.index(['slashed_events'])
    table.index(['last_slashed_at_time'])
  })
  await knex.raw(`
    ALTER TABLE corporations ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(cgf_text, '')), 'D')
    ) STORED
  `)
  await knex.raw('CREATE INDEX corporations_search_vec_idx ON corporations USING GIN (search_vec)')

  await knex.schema.createTable('ecosystems', table => {
    table.bigInteger('id').primary()
    table.text('did').nullable()
    table.boolean('archived').notNullable().defaultTo(false)
    table.bigInteger('corporation_id').notNullable()
    table.jsonb('participants').nullable()
    table.bigInteger('issued_credentials').nullable()
    table.bigInteger('verified_credentials').nullable()
    table.specificType('credential_schema_ids', 'bigint[]').notNullable().defaultTo('{}')
    table.jsonb('egf').nullable()
    table.text('egf_text').nullable()
    FRESHNESS(table)
    table.index(['did'])
    table.index(['corporation_id'])
    table.index(['archived'])
    table.index(['issued_credentials'])
    table.index(['verified_credentials'])
  })
  await knex.raw(`
    ALTER TABLE ecosystems ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(egf_text, '')), 'D')
    ) STORED
  `)
  await knex.raw('CREATE INDEX ecosystems_search_vec_idx ON ecosystems USING GIN (search_vec)')

  await knex.schema.createTable('credential_schemas', table => {
    table.bigInteger('id').primary()
    table.text('type').notNullable()
    table.text('digest_sri').notNullable()
    table.boolean('archived').notNullable().defaultTo(false)
    table.bigInteger('ecosystem_id').notNullable()
    table.jsonb('participants').nullable()
    table.bigInteger('issued_credentials').nullable()
    table.bigInteger('verified_credentials').nullable()
    // TG-DEREF-2: row is inserted only after load + digestSri validation succeed, so body is
    // never null once the record exists
    table.jsonb('body').notNullable()
    table.text('title').nullable()
    table.text('description').nullable()
    FRESHNESS(table)
    table.index(['ecosystem_id'])
    table.index(['archived'])
    table.index(['issued_credentials'])
    table.index(['verified_credentials'])
  })
  await knex.raw(`
    ALTER TABLE credential_schemas ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')), 'C')
    ) STORED
  `)
  await knex.raw(
    'CREATE INDEX credential_schemas_search_vec_idx ON credential_schemas USING GIN (search_vec)',
  )

  await knex.schema.createTable('service_endpoints', table => {
    table.text('id').primary()
    table.text('did_id').notNullable()
    table.text('type').notNullable()
    table.jsonb('service_endpoint').notNullable()
    table.specificType('accept', 'text[]').nullable()
    FRESHNESS(table)
    table.index(['did_id'])
    table.index(['type'])
  })

  await knex.schema.createTable('linked_vps', table => {
    table.text('id').primary()
    table.text('service_id').notNullable()
    table.text('did_id').notNullable()
    FRESHNESS(table)
    table.index(['did_id'])
  })

  await knex.schema.createTable('ecs_credentials', table => {
    table.text('id').primary()
    // true when upstream omitted the credential id and a synthetic one was assigned
    table.boolean('synthetic_id').notNullable().defaultTo(false)
    table
      .text('ecs_schema')
      .notNullable()
      .checkIn(['ServiceCredential', 'OrganizationCredential', 'PersonaCredential'])
    table.text('ecs_schema_version').notNullable()
    table.bigInteger('credential_schema_id').notNullable()
    table.bigInteger('issuer_participant_id').notNullable()
    table.bigInteger('ecosystem_id').notNullable()
    table.bigInteger('participant_id').notNullable()
    table.text('subject_did').notNullable()
    table.timestamp('valid_from', { useTz: true }).notNullable()
    table.timestamp('valid_until', { useTz: true }).nullable()
    table.jsonb('credential_subject').notNullable()
    FRESHNESS(table)
    table.index(['subject_did'])
    table.index(['issuer_participant_id'])
    table.index(['participant_id'])
    table.index(['credential_schema_id'])
    table.index(['ecosystem_id'])
    table.index(['ecs_schema'])
    table.index(['valid_until'])
  })

  await knex.schema.createTable('vtcs', table => {
    table.text('id').primary()
    table.bigInteger('credential_schema_id').notNullable()
    table.bigInteger('ecosystem_id').notNullable()
    table.bigInteger('participant_id').notNullable()
    table.bigInteger('issuer_participant_id').notNullable()
    // populated only when FETCH_VP_BODIES is enabled (TG-DEREF-3 optional body fetch)
    table.text('subject_text').nullable()
    FRESHNESS(table)
    table.index(['credential_schema_id'])
    table.index(['ecosystem_id'])
    table.index(['participant_id'])
    table.index(['issuer_participant_id'])
  })

  // CONTAINS_VTC is the one edge that is genuinely many-to-many; every other edge in the
  // catalogue is a projection of an anchor column on its source entity
  await knex.schema.createTable('lvp_vtcs', table => {
    table.text('lvp_id').notNullable()
    table.text('vtc_id').notNullable()
    FRESHNESS(table)
    table.primary(['lvp_id', 'vtc_id'])
    table.index(['vtc_id'])
  })

  await knex.schema.createTable('participants', table => {
    table.bigInteger('id').primary()
    table.text('did_id').notNullable()
    table.bigInteger('corporation_id').notNullable()
    table.text('vs_operator').nullable()
    table.bigInteger('credential_schema_id').notNullable()
    table.bigInteger('ecosystem_id').notNullable()
    table
      .text('role')
      .notNullable()
      .checkIn(['HOLDER', 'ISSUER', 'VERIFIER', 'ISSUER_GRANTOR', 'VERIFIER_GRANTOR', 'ECOSYSTEM'])
    // TG-ACT-1: only ACTIVE participants are ever persisted
    table.text('state').notNullable().checkIn(['ACTIVE'])
    table.text('weight').nullable()
    table.specificType('weight_amount', 'NUMERIC(38,0)').nullable()
    table.bigInteger('issued_credentials').nullable()
    table.bigInteger('verified_credentials').nullable()
    table.jsonb('participants_by_child_role').nullable()
    table.bigInteger('validator_participant_id').nullable()
    FRESHNESS(table)
    table.index(['did_id'])
    table.index(['corporation_id'])
    table.index(['credential_schema_id'])
    table.index(['ecosystem_id'])
    table.index(['validator_participant_id'])
    table.index(['role', 'credential_schema_id'])
    table.index(['role', 'ecosystem_id'])
  })
  // TG-EDGE-4: validatorParticipantId is null iff role = ECOSYSTEM
  await knex.raw(`
    ALTER TABLE participants ADD CONSTRAINT participants_validator_null_iff_root
    CHECK ((role = 'ECOSYSTEM') = (validator_participant_id IS NULL))
  `)

  await knex.schema.createTable('gf_doc_bodies', table => {
    table.text('digest_sri').primary()
    table.text('url').notNullable()
    table.text('body').notNullable()
    table.timestamp('fetched_at', { useTz: true }).notNullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'gf_doc_bodies',
    'participants',
    'lvp_vtcs',
    'vtcs',
    'ecs_credentials',
    'linked_vps',
    'service_endpoints',
    'credential_schemas',
    'ecosystems',
    'corporations',
    'dids',
    'ingestion_state',
  ]) {
    await knex.schema.dropTableIfExists(t)
  }
}
