import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createDb } from '../../src/db/knex'

// knex.ts registers migrations in a static map, so a new file on disk that nobody adds there
// never runs and every other suite still passes. This is the only thing that catches that.
describe('migration registry', () => {
  it('registers every migration file on disk', async () => {
    const onDisk = readdirSync(new URL('../../src/db/migrations', import.meta.url))
      .filter(f => f.endsWith('.ts'))
      .sort()
    const db = createDb('postgres://unused@127.0.0.1:1/unused')
    const { migrationSource } = db.client.config.migrations
    expect(await migrationSource.getMigrations()).toEqual(onDisk)
    await db.destroy()
  })
})
