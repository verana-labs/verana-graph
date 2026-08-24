import type { FastifyReply, FastifyRequest } from 'fastify'
// TG-ERR-1: closed code set, HTTP status fixed per code
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_QUERY'
  | 'UNKNOWN_FILTER_FIELD'
  | 'INVALID_CURSOR'
  | 'UNKNOWN_ID'

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }

  get httpStatus(): number {
    return this.code === 'UNKNOWN_ID' ? 404 : 400
  }

  toBody(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } }
  }
}

export function apiErrorHandler(
  logError: (message: string) => void,
): (err: Error & { statusCode?: number }, req: FastifyRequest, reply: FastifyReply) => FastifyReply {
  return (err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.httpStatus).send(err.toBody())
    if (err.statusCode === 400) {
      return reply
        .status(400)
        .send({ error: { code: 'INVALID_INPUT', message: 'request body is not parseable' } })
    }
    logError(err.message)
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } })
  }
}
