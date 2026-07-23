import { createHash } from 'crypto'
import { ApiError } from '../errors.js'

export interface CursorPayload {
  s: number
  k: string
  h: string
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(v)
}

// the cursor is bound to the query it came from; reuse under a different query is an explicit
// error, never a silent re-anchor (TG-FCT-7)
export function queryHash(request: Record<string, unknown>): string {
  const { cursor: _cursor, limit: _limit, ...rest } = request
  return createHash('sha256').update(stableStringify(rest)).digest('hex').slice(0, 16)
}

export function encodeCursor(score: number, key: string, hash: string): string {
  return Buffer.from(JSON.stringify({ s: score, k: key, h: hash })).toString('base64url')
}

export function decodeCursor(cursor: string, expectedHash: string): CursorPayload {
  let payload: CursorPayload
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new ApiError('INVALID_CURSOR', 'cursor is not decodable')
  }
  if (typeof payload.s !== 'number' || typeof payload.k !== 'string' || payload.h !== expectedHash) {
    throw new ApiError('INVALID_CURSOR', 'cursor does not belong to this query')
  }
  return payload
}
