import { createHash } from 'node:crypto'
import { ApiError } from '../errors'
import { stableStringify } from '../search/cursor'

const DEFAULT_LIMIT = 100

export interface PageReq {
  limit: number
  after: string | null
  hash: string
}

export function pageHash(query: string, input: unknown): string {
  return createHash('sha256').update(stableStringify({ query, input })).digest('hex').slice(0, 16)
}

function encodeKey(key: string, hash: string): string {
  return Buffer.from(JSON.stringify({ k: key, h: hash })).toString('base64url')
}

export function decodeKey(cursor: string | undefined, hash: string): string | null {
  if (cursor === undefined) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new ApiError('INVALID_CURSOR', 'cursor is not decodable')
  }
  if (!payload || typeof payload !== 'object') {
    throw new ApiError('INVALID_CURSOR', 'cursor is not decodable')
  }
  const { k, h } = payload as { k?: unknown; h?: unknown }
  if (typeof k !== 'string' || h !== hash) {
    throw new ApiError('INVALID_CURSOR', 'cursor does not belong to this query')
  }
  return k
}

export function resolveLimit(limit: unknown): number {
  return typeof limit === 'number' ? limit : DEFAULT_LIMIT
}

export function takePage<T>(
  rows: T[],
  page: PageReq,
  keyOf: (row: T) => string,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= page.limit) return { rows, nextCursor: null }
  const kept = rows.slice(0, page.limit)
  const last = kept[kept.length - 1]
  return { rows: kept, nextCursor: last === undefined ? null : encodeKey(keyOf(last), page.hash) }
}

export type DualKey = { phase: 'ecs'; subjectDid: string; id: string } | { phase: 'vtc'; id: string }

export function encodeDualKey(k: DualKey): string {
  return k.phase === 'ecs' ? `e\u0000${k.subjectDid}\u0000${k.id}` : `v\u0000${k.id}`
}

export function parseDualKey(key: string | null): DualKey | null {
  if (key === null) return null
  const parts = key.split('\u0000')
  if (parts[0] === 'e' && parts.length === 3) {
    return { phase: 'ecs', subjectDid: parts[1] as string, id: parts[2] as string }
  }
  if (parts[0] === 'v' && parts.length === 2) return { phase: 'vtc', id: parts[1] as string }
  throw new ApiError('INVALID_CURSOR', 'cursor key is not valid for this query')
}
