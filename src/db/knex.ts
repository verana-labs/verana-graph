import knex, { Knex } from 'knex'
import pg from 'pg'
import * as m0001 from './migrations/0001_init'
import * as m0002 from './migrations/0002_nullable_corporation'
import * as m0003 from './migrations/0003_nullable_participant_corp'
import * as m0004 from './migrations/0004_nullable_expires_at_time'
import * as m0005 from './migrations/0005_ecs_credential_issuance'
import * as m0006 from './migrations/0006_participant_states'

// int8 (block heights, VPR ids) parsed as Number: practical uint64 values in this domain fit
// well below 2^53. numeric (coin amounts) stays a string.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10))

// static imports so migrations load identically under tsx, vitest, and compiled dist;
// names keep the .ts suffix to match rows already recorded by the old directory loader
const MIGRATIONS: Record<string, Knex.Migration> = {
  '0001_init.ts': m0001,
  '0002_nullable_corporation.ts': m0002,
  '0003_nullable_participant_corp.ts': m0003,
  '0004_nullable_expires_at_time.ts': m0004,
  '0005_ecs_credential_issuance.ts': m0005,
  '0006_participant_states.ts': m0006,
}

export function createDb(databaseUrl: string): Knex {
  return knex({
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 1, max: 10 },
    migrations: {
      migrationSource: {
        getMigrations: async () => Object.keys(MIGRATIONS).sort(),
        getMigrationName: (name: string) => name,
        getMigration: async (name: string) => MIGRATIONS[name] as Knex.Migration,
      },
    },
  })
}

export type Db = Knex
