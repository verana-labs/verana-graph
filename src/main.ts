import Fastify from 'fastify'
import { registerDocs } from './api/docs'
import { apiErrorHandler } from './api/errors'
import { registerSearchRoute } from './api/search/route'
import { registerTraverseRoute } from './api/traverse/route'
import { attachBlockProgressServer } from './bps/server'
import { loadConfig } from './config'
import { createDb } from './db/knex'
import { Dereferencer } from './deref/deref'
import { IndexerRestClient } from './indexer/rest'
import { IngestOrchestrator } from './ingest/orchestrator'
import { createLogger } from './util/logger'

const config = loadConfig()
const log = createLogger(config.logLevel)
const db = createDb(config.databaseUrl)

await db.migrate.latest()

const rest = new IndexerRestClient(config.indexerBaseUrl)
const deref = new Dereferencer(db, rest, config, log)
const orchestrator = new IngestOrchestrator(
  db,
  rest,
  deref,
  config.indexerWsUrl,
  log,
  config.trustRefreshIntervalMs,
  config.trustRefreshBatch,
)

const app = Fastify({ logger: { level: config.logLevel } })
app.setErrorHandler(apiErrorHandler(message => log.error({ err: message }, 'unhandled api error')))
app.get('/health', async () => ({
  status: 'ok',
  lastAppliedBlock: orchestrator.currentState.lastAppliedBlock,
}))
registerDocs(app)
registerTraverseRoute(app, db)
registerSearchRoute(app, db, config)

await app.listen({ port: config.port, host: '0.0.0.0' })
attachBlockProgressServer(app.server, orchestrator, config.bpsMaxBufferedBytes, log)
await orchestrator.start()
log.info({ port: config.port }, 'verana-graph up')

const shutdown = async (): Promise<void> => {
  orchestrator.stop()
  await app.close()
  await db.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
