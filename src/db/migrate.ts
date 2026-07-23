import { loadConfig } from '../config.js'
import { createDb } from './knex.js'

const db = createDb(loadConfig().databaseUrl)
const [, applied] = await db.migrate.latest()
// biome-ignore lint/suspicious/noConsole: CLI entrypoint
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date')
await db.destroy()
