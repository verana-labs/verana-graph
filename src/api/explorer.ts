import { readFileSync } from 'node:fs'
import { FastifyInstance } from 'fastify'

export function registerExplorer(app: FastifyInstance): void {
  const html = readFileSync(new URL('../../public/explorer.html', import.meta.url), 'utf8')
  app.get('/explorer', async (_req, reply) => reply.type('text/html; charset=utf-8').send(html))
}
