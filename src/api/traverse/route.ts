import { readFileSync } from 'node:fs'
import { Ajv2020 as Ajv, ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { FastifyInstance } from 'fastify'
import { Knex } from 'knex'
import { ApiError } from '../errors'
import * as q from './queries'

type Handler = (db: Knex, input: never) => Promise<unknown>

const HANDLERS: Record<string, Handler> = {
  A1: q.a1,
  A2: q.a2,
  A3: q.a3,
  A4: q.a4,
  A5: q.a5,
  A6: q.a6,
  A7: q.a7,
  B1: q.b1,
  B2: q.b2,
  C1: q.c1,
  C2: q.c2,
  C3: q.c3,
  D1: q.d1,
  D2: q.d2,
  E1: q.e1,
  E2: q.e2,
  E3: q.e3,
  F1: q.f1,
  G1: q.g1,
}

function compileRequestSchema(): ValidateFunction {
  const schemaPath = new URL('../../../spec/graph/traverse.request.schema.json', import.meta.url)
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv({ strict: false })
  addFormats.default(ajv as never)
  return ajv.compile(schema)
}

export function registerTraverseRoute(app: FastifyInstance, db: Knex): void {
  const validate = compileRequestSchema()

  // TG-QRY-5: the single REST binding endpoint, dispatching on the query selector
  app.post('/v4/graph/traverse', async (request, reply) => {
    const body = request.body as { query?: string; input?: unknown }
    // selector first: the schema enumerates it, so validating first would mask UNKNOWN_QUERY
    if (typeof body?.query === 'string' && !HANDLERS[body.query]) {
      throw new ApiError('UNKNOWN_QUERY', `unknown query ${body.query}`)
    }
    if (!validate(body)) {
      const detail = (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')
      throw new ApiError('INVALID_INPUT', `request does not match traverse schema: ${detail}`)
    }
    const handler = HANDLERS[body.query as string]
    if (!handler) throw new ApiError('UNKNOWN_QUERY', `unknown query ${body.query}`)
    const output = await handler(db, body.input as never)
    return reply.send({
      query: body.query,
      evaluatedAtTime: new Date().toISOString(),
      output,
    })
  })
}
