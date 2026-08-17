import type { Knex } from 'knex'

const STATES = ['ACTIVE', 'FUTURE', 'INACTIVE', 'EXPIRED', 'REVOKED', 'SLASHED', 'REPAID']

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE participants DROP CONSTRAINT participants_state_check')
  await knex.raw(
    `ALTER TABLE participants ADD CONSTRAINT participants_state_check CHECK (state IN (${STATES.map(s => `'${s}'`).join(', ')}))`,
  )
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DELETE FROM participants WHERE state <> 'ACTIVE'")
  await knex.raw('ALTER TABLE participants DROP CONSTRAINT participants_state_check')
  await knex.raw(
    "ALTER TABLE participants ADD CONSTRAINT participants_state_check CHECK (state IN ('ACTIVE'))",
  )
}
