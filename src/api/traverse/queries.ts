import { Knex } from 'knex'
import { ApiError } from '../errors'
import { type DualKey, encodeDualKey, type PageReq, parseDualKey, takePage } from './cursor'

export interface Paged {
  output: Json | Json[]
  nextCursor: string | null
}

import {
  corporationRef,
  DidRow,
  didRef,
  EcsCredentialRow,
  ecosystemRef,
  ecsCredentialRef,
  isTrustExpired,
  ParticipantRow,
  participantRef,
  schemaRef,
  serviceEndpointRef,
  VtcRow,
  vtcRef,
} from '../refs'

type Json = Record<string, unknown>

// record-level validity: expired credentials are never returned (TG-ACT-1)
function validEcs(q: Knex.QueryBuilder): Knex.QueryBuilder {
  return q.where(b => b.whereNull('valid_until').orWhere('valid_until', '>=', new Date().toISOString()))
}

async function getDidRow(db: Knex, did: string): Promise<DidRow> {
  const row = await db('dids').where({ did }).first<DidRow | undefined>()
  if (!row) throw new ApiError('UNKNOWN_ID', `unknown did ${did}`)
  return row
}

// A1 - trust summary: the Did record alone, no edge walk
export async function a1(db: Knex, input: { did: string }): Promise<Json> {
  const row = await getDidRow(db, input.did)
  return {
    did: row.did,
    trusted: row.trusted,
    evaluatedAtTime: row.evaluated_at_time.toISOString(),
    evaluatedAtBlock: row.evaluated_at_block,
    expiresAtTime: row.expires_at_time ? row.expires_at_time.toISOString() : null,
    isTrustExpired: isTrustExpired(row),
    lastObservedAtTime: row.last_observed_at_time.toISOString(),
    corporationId: row.corporation_id,
    pattern: row.pattern,
  }
}

// A2 - governing chain: OPERATED_BY corp + deduplicated ecosystems via Participant.ecosystemId (TG-EDGE-3)
export async function a2(db: Knex, input: { did: string }): Promise<Json> {
  const row = await getDidRow(db, input.did)
  let corporation = null
  if (row.corporation_id !== null) {
    const corp = await db('corporations').where('id', row.corporation_id).first()
    corporation = corp ? corporationRef(corp) : { id: row.corporation_id }
  }
  const ecosystems = await db('ecosystems')
    .whereIn('id', db('participants').where('did_id', input.did).select('ecosystem_id'))
    .orderBy('id')
  return { corporation, ecosystems: ecosystems.map(ecosystemRef) }
}

// A3 - service endpoints (Linked-VP entries live under A4)
export async function a3(db: Knex, input: { did: string }): Promise<Json[]> {
  await getDidRow(db, input.did)
  const rows = await db('service_endpoints').where('did_id', input.did).orderBy('id')
  return rows.map(serviceEndpointRef)
}

// A4 - linked VPs and contained VTCs
export async function a4(db: Knex, input: { did: string }, page: PageReq): Promise<Paged> {
  await getDidRow(db, input.did)
  let vpQ = db('linked_vps').where('did_id', input.did)
  if (page.after) vpQ = vpQ.where('id', '>', page.after)
  const raw = await vpQ.orderBy('id').limit(page.limit + 1)
  const { rows: vps, nextCursor } = takePage(raw, page, r => String(r.id))
  const out: Json[] = []
  for (const vp of vps) {
    const vtcs = await db('vtcs as v')
      .join('lvp_vtcs as lv', 'lv.vtc_id', 'v.id')
      .where('lv.lvp_id', vp.id)
      .select<VtcRow[]>('v.*')
      .orderBy('v.id')
    out.push({
      id: vp.id,
      serviceId: vp.service_id,
      lastObservedAtTime: vp.last_observed_at_time.toISOString(),
      vtcs: vtcs.map(vtcRef),
    })
  }
  return { output: out, nextCursor }
}

// TG-QRY-3: a schema or ecosystem that is not yet materialised is returned as { id }
async function enrich(db: Knex, schemaId: number, ecosystemId: number): Promise<Json> {
  const schema = await db('credential_schemas').where('id', schemaId).first()
  const ecosystem = await db('ecosystems').where('id', ecosystemId).first()
  return {
    schema: schema ? schemaRef(schema) : { id: schemaId },
    ecosystem: ecosystem ? ecosystemRef(ecosystem) : { id: ecosystemId },
  }
}

// A5 - held credentials (DID is subject), enriched with issuer, schema, ecosystem
export async function a5(
  db: Knex,
  input: { did: string; ecsSchema?: string },
  page: PageReq,
): Promise<Paged> {
  await getDidRow(db, input.did)
  let q = validEcs(db('ecs_credentials').where('subject_did', input.did))
  if (input.ecsSchema) q = q.where('ecs_schema', input.ecsSchema)
  if (page.after) q = q.where('id', '>', page.after)
  const raw = await q
    .orderBy('id')
    .limit(page.limit + 1)
    .select<EcsCredentialRow[]>()
  const { rows: creds, nextCursor } = takePage(raw, page, r => r.id)
  const out: Json[] = []
  for (const c of creds) {
    const item: Json = {
      credential: ecsCredentialRef(c),
      ...(await enrich(db, c.credential_schema_id, c.ecosystem_id)),
    }
    const issuer = await db('participants')
      .where('id', c.issuer_participant_id)
      .first<ParticipantRow | undefined>()
    if (issuer) {
      item.issuerDid = issuer.did_id
      item.issuerParticipant = participantRef(issuer)
    }
    out.push(item)
  }
  return { output: out, nextCursor }
}

async function fetchDualPage(
  ecsBase: Knex.QueryBuilder,
  vtcBase: Knex.QueryBuilder | null,
  page: PageReq,
): Promise<{ ecs: EcsCredentialRow[]; vtcs: VtcRow[]; nextCursor: string | null }> {
  const anchor = parseDualKey(page.after)
  const want = page.limit + 1
  let ecs: EcsCredentialRow[] = []
  if (!anchor || anchor.phase === 'ecs') {
    let q = ecsBase
    if (anchor && anchor.phase === 'ecs') {
      q = q.whereRaw('(subject_did, id) > (?, ?)', [anchor.subjectDid, anchor.id])
    }
    ecs = await q.orderBy(['subject_did', 'id']).limit(want).select<EcsCredentialRow[]>()
  }
  let vtcs: VtcRow[] = []
  if (vtcBase && ecs.length < want) {
    let q = vtcBase
    if (anchor && anchor.phase === 'vtc') q = q.where('id', '>', anchor.id)
    vtcs = await q
      .orderBy('id')
      .limit(want - ecs.length)
      .select<VtcRow[]>()
  }
  const keys: DualKey[] = [
    ...ecs.map(c => ({ phase: 'ecs' as const, subjectDid: c.subject_did, id: c.id })),
    ...vtcs.map(v => ({ phase: 'vtc' as const, id: v.id })),
  ]
  const { nextCursor } = takePage(keys, page, encodeDualKey)
  const keep = keys.length > page.limit ? page.limit : keys.length
  const ecsKeep = Math.min(ecs.length, keep)
  return { ecs: ecs.slice(0, ecsKeep), vtcs: vtcs.slice(0, keep - ecsKeep), nextCursor }
}

// A6 - issued credentials: outflow through the DID's ISSUER participants
export async function a6(
  db: Knex,
  input: { did: string; ecsSchema?: string },
  page: PageReq,
): Promise<Paged> {
  await getDidRow(db, input.did)
  const issuerIds = db('participants').where('did_id', input.did).select('id')
  let ecsQ = validEcs(db('ecs_credentials').whereIn('issuer_participant_id', issuerIds))
  if (input.ecsSchema) ecsQ = ecsQ.where('ecs_schema', input.ecsSchema)
  const vtcQ = input.ecsSchema ? null : db('vtcs').whereIn('issuer_participant_id', issuerIds)
  const { ecs, vtcs, nextCursor } = await fetchDualPage(ecsQ, vtcQ, page)

  const ecsItems: Json[] = []
  for (const c of ecs) {
    const refs = await enrich(db, c.credential_schema_id, c.ecosystem_id)
    ecsItems.push({ credential: ecsCredentialRef(c), subjectDid: c.subject_did, ...refs })
  }
  const vtcItems: Json[] = []
  for (const v of vtcs) {
    const refs = await enrich(db, v.credential_schema_id, v.ecosystem_id)
    const holder = await db('participants').where('id', v.participant_id).first<ParticipantRow | undefined>()
    vtcItems.push({
      credential: vtcRef(v),
      ...(holder ? { subjectDid: holder.did_id } : {}),
      ...refs,
    })
  }
  return { output: { ecsCredentials: ecsItems, vtcs: vtcItems }, nextCursor }
}

// A7 - participants by role
export async function a7(db: Knex, input: { did: string; role?: string }, page: PageReq): Promise<Paged> {
  await getDidRow(db, input.did)
  let q = db('participants').where('did_id', input.did)
  if (input.role) q = q.where('role', input.role)
  if (page.after) q = q.where('id', '>', Number(page.after))
  const raw = await q
    .orderBy('id')
    .limit(page.limit + 1)
    .select<ParticipantRow[]>()
  const { rows, nextCursor } = takePage(raw, page, r => String(r.id))
  const out: Json[] = []
  for (const p of rows) {
    out.push({
      participant: participantRef(p),
      ...(await enrich(db, p.credential_schema_id, p.ecosystem_id)),
    })
  }
  return { output: out, nextCursor }
}

async function findCredential(
  db: Knex,
  did: string,
  credentialId: string,
): Promise<{ kind: 'ecs'; row: EcsCredentialRow } | { kind: 'vtc'; row: VtcRow }> {
  const ecs = await validEcs(db('ecs_credentials').where({ subject_did: did, id: credentialId })).first<
    EcsCredentialRow | undefined
  >()
  if (ecs) return { kind: 'ecs', row: ecs }
  const vtc = await db('vtcs as v')
    .join('lvp_vtcs as lv', 'lv.vtc_id', 'v.id')
    .join('linked_vps as vp', 'vp.id', 'lv.lvp_id')
    .where({ 'v.id': credentialId, 'vp.did_id': did })
    .first<VtcRow | undefined>('v.*')
  if (vtc) return { kind: 'vtc', row: vtc }
  throw new ApiError('UNKNOWN_ID', `unknown credential ${credentialId}`)
}

// B1 - issuer recovery
export async function b1(db: Knex, input: { did: string; credentialId: string }): Promise<Json> {
  const found = await findCredential(db, input.did, input.credentialId)
  const issuer = await db('participants')
    .where('id', found.row.issuer_participant_id)
    .first<ParticipantRow | undefined>()
  if (!issuer) {
    throw new ApiError('UNKNOWN_ID', `unknown issuer participant ${found.row.issuer_participant_id}`)
  }
  return {
    credential: found.kind === 'ecs' ? ecsCredentialRef(found.row) : vtcRef(found.row),
    issuerDid: issuer.did_id,
    issuerParticipant: participantRef(issuer),
    ...(await enrich(db, found.row.credential_schema_id, found.row.ecosystem_id)),
  }
}

// B2 - holder recovery
export async function b2(db: Knex, input: { did: string; credentialId: string }): Promise<Json> {
  const found = await findCredential(db, input.did, input.credentialId)
  const holder = await db('participants')
    .where('id', found.row.participant_id)
    .first<ParticipantRow | undefined>()
  if (!holder) {
    throw new ApiError('UNKNOWN_ID', `holder participant ${found.row.participant_id} no longer ACTIVE`)
  }
  return {
    credential: found.kind === 'ecs' ? ecsCredentialRef(found.row) : vtcRef(found.row),
    subjectDid: found.kind === 'ecs' ? found.row.subject_did : holder.did_id,
    holderParticipant: participantRef(holder),
  }
}

// C1 - owned schemas
export async function c1(db: Knex, input: { ecosystemId: number }, page: PageReq): Promise<Paged> {
  const eco = await db('ecosystems').where('id', input.ecosystemId).first()
  if (!eco) throw new ApiError('UNKNOWN_ID', `unknown ecosystem ${input.ecosystemId}`)
  let q = db('credential_schemas').where('ecosystem_id', input.ecosystemId)
  if (page.after) q = q.where('id', '>', Number(page.after))
  const raw = await q.orderBy('id').limit(page.limit + 1)
  const { rows, nextCursor } = takePage(raw, page, r => String(r.id))
  return { output: rows.map(schemaRef), nextCursor }
}

// C2 / D2 - participating DIDs grouped by role; empty role keys are omitted
async function roleToDids(base: Knex.QueryBuilder, page: PageReq): Promise<Paged> {
  const raw = await base.limit(page.limit + 1).select<(ParticipantRow & DidRow)[]>()
  const { rows, nextCursor } = takePage(raw, page, r => String(r.id))
  const grouped: Record<string, Json[]> = {}
  for (const row of rows) {
    const role = row.role
    grouped[role] = grouped[role] ?? []
    grouped[role].push({ did: didRef(row), participant: participantRef(row) })
  }
  return { output: grouped, nextCursor }
}

export async function c2(
  db: Knex,
  input: { ecosystemId: number; role?: string; credentialSchemaId?: number },
  page: PageReq,
): Promise<Paged> {
  const eco = await db('ecosystems').where('id', input.ecosystemId).first('id')
  if (!eco) throw new ApiError('UNKNOWN_ID', `unknown ecosystem ${input.ecosystemId}`)
  let q = db('participants as p')
    .join('dids as d', 'd.did', 'p.did_id')
    .where('p.ecosystem_id', input.ecosystemId)
  if (input.role) q = q.where('p.role', input.role)
  if (input.credentialSchemaId !== undefined) q = q.where('p.credential_schema_id', input.credentialSchemaId)
  if (page.after) q = q.where('p.id', '>', Number(page.after))
  return roleToDids(q.select('p.*', 'd.*').orderBy('p.id'), page)
}

// C3 / E3 - governance framework summaries
export async function c3(db: Knex, input: { ecosystemId: number }): Promise<Json> {
  const eco = await db('ecosystems').where('id', input.ecosystemId).first()
  if (!eco) throw new ApiError('UNKNOWN_ID', `unknown ecosystem ${input.ecosystemId}`)
  return { egf: eco.egf ?? null }
}

// D1 - credentials based on a schema
export async function d1(db: Knex, input: { credentialSchemaId: number }, page: PageReq): Promise<Paged> {
  const schema = await db('credential_schemas').where('id', input.credentialSchemaId).first('id')
  if (!schema) throw new ApiError('UNKNOWN_ID', `unknown schema ${input.credentialSchemaId}`)
  const { ecs, vtcs, nextCursor } = await fetchDualPage(
    validEcs(db('ecs_credentials').where('credential_schema_id', input.credentialSchemaId)),
    db('vtcs').where('credential_schema_id', input.credentialSchemaId),
    page,
  )
  return {
    output: { ecsCredentials: ecs.map(ecsCredentialRef), vtcs: vtcs.map(vtcRef) },
    nextCursor,
  }
}

export async function d2(
  db: Knex,
  input: { credentialSchemaId: number; role?: string },
  page: PageReq,
): Promise<Paged> {
  const schema = await db('credential_schemas').where('id', input.credentialSchemaId).first('id')
  if (!schema) throw new ApiError('UNKNOWN_ID', `unknown schema ${input.credentialSchemaId}`)
  let q = db('participants as p')
    .join('dids as d', 'd.did', 'p.did_id')
    .where('p.credential_schema_id', input.credentialSchemaId)
  if (input.role) q = q.where('p.role', input.role)
  if (page.after) q = q.where('p.id', '>', Number(page.after))
  return roleToDids(q.select('p.*', 'd.*').orderBy('p.id'), page)
}

// E1 - DIDs operated by a corporation
export async function e1(db: Knex, input: { corporationId: number }, page: PageReq): Promise<Paged> {
  const corp = await db('corporations').where('id', input.corporationId).first('id')
  if (!corp) throw new ApiError('UNKNOWN_ID', `unknown corporation ${input.corporationId}`)
  let q = db('dids').where('corporation_id', input.corporationId)
  if (page.after) q = q.where('did', '>', page.after)
  const raw = await q
    .orderBy('did')
    .limit(page.limit + 1)
    .select<DidRow[]>()
  const { rows, nextCursor } = takePage(raw, page, r => r.did)
  return { output: rows.map(didRef), nextCursor }
}

// E2 - ecosystems controlled by a corporation
export async function e2(db: Knex, input: { corporationId: number }, page: PageReq): Promise<Paged> {
  const corp = await db('corporations').where('id', input.corporationId).first('id')
  if (!corp) throw new ApiError('UNKNOWN_ID', `unknown corporation ${input.corporationId}`)
  let q = db('ecosystems').where('corporation_id', input.corporationId)
  if (page.after) q = q.where('id', '>', Number(page.after))
  const raw = await q.orderBy('id').limit(page.limit + 1)
  const { rows, nextCursor } = takePage(raw, page, r => String(r.id))
  return { output: rows.map(ecosystemRef), nextCursor }
}

export async function e3(db: Knex, input: { corporationId: number }): Promise<Json> {
  const corp = await db('corporations').where('id', input.corporationId).first()
  if (!corp) throw new ApiError('UNKNOWN_ID', `unknown corporation ${input.corporationId}`)
  return { cgf: corp.cgf ?? null }
}

// G1 - validator chain, root to leaf inclusive (TG-EDGE-4: finite tree, one ecosystem)
export async function g1(db: Knex, input: { participantId: number }): Promise<Json[]> {
  const leaf = await db('participants').where('id', input.participantId).first('id')
  if (!leaf) throw new ApiError('UNKNOWN_ID', `unknown participant ${input.participantId}`)
  const result = await db.raw(
    `
    WITH RECURSIVE chain AS (
      SELECT p.*, 0 AS depth FROM participants p WHERE p.id = ?
      UNION ALL
      SELECT p.*, chain.depth + 1 FROM participants p
      JOIN chain ON p.id = chain.validator_participant_id
    )
    SELECT * FROM chain ORDER BY depth DESC
    `,
    [input.participantId],
  )
  return (result.rows as ParticipantRow[]).map(participantRef)
}

// F1 - shortest trust path (SHOULD): BFS over the projected edge catalogue
interface PathNode {
  type: string
  id: string | number
}

const MAX_PATH_DEPTH = 12

const NODE_TABLES: Record<string, [table: string, key: string, integerKey: boolean]> = {
  Did: ['dids', 'did', false],
  Corporation: ['corporations', 'id', true],
  Ecosystem: ['ecosystems', 'id', true],
  CredentialSchema: ['credential_schemas', 'id', true],
  Participant: ['participants', 'id', true],
  EcsCredential: ['ecs_credentials', 'id', false],
  Vtc: ['vtcs', 'id', false],
  LinkedVerifiablePresentation: ['linked_vps', 'id', false],
  ServiceEndpoint: ['service_endpoints', 'id', false],
}

const CREDENTIAL_TABLES = [
  ['ecs_credentials', 'EcsCredential'],
  ['vtcs', 'Vtc'],
] as const

async function assertNode(db: Knex, n: PathNode): Promise<void> {
  const [table, key, integerKey] = NODE_TABLES[n.type] as [string, string, boolean]
  // checked first: a string id against a bigint key is a Postgres cast error, not a miss
  const typed = integerKey
    ? /^\d+$/.test(String(n.id)) && Number.isSafeInteger(Number(n.id))
    : typeof n.id === 'string'
  if (!typed || !(await db(table).where(key, n.id).first(key))) {
    throw new ApiError('UNKNOWN_ID', `unknown ${n.type} ${n.id}`)
  }
}

export async function f1(db: Knex, input: { from: PathNode; to: PathNode }): Promise<Json | null> {
  await assertNode(db, input.from)
  await assertNode(db, input.to)
  const key = (n: PathNode) => `${n.type}:${NODE_TABLES[n.type]?.[2] ? Number(n.id) : n.id}`
  const start = { node: input.from, path: [] as { node: PathNode; edge?: string }[] }
  const target = key(input.to)
  const visited = new Set<string>([key(input.from)])
  let frontier = [start]

  for (let depth = 0; depth < MAX_PATH_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = []
    for (const item of frontier) {
      const neighbors = await neighborsOf(db, item.node)
      for (const { node, edge } of neighbors) {
        const k = key(node)
        if (visited.has(k)) continue
        visited.add(k)
        const path = [...item.path, { node: item.node, edge }]
        if (k === target) return [...path, { node }] as unknown as Json
        next.push({ node, path })
      }
    }
    frontier = next
  }
  return null
}

async function neighborsOf(db: Knex, n: PathNode): Promise<{ node: PathNode; edge: string }[]> {
  const out: { node: PathNode; edge: string }[] = []
  const push = (type: string, id: string | number | null, edge: string) => {
    if (id !== null && id !== undefined && id !== 0) out.push({ node: { type, id }, edge })
  }
  switch (n.type) {
    case 'Did': {
      const d = await db('dids').where('did', n.id).first()
      if (d) push('Corporation', d.corporation_id, 'OPERATED_BY')
      const parts = await db('participants').where('did_id', n.id).select('id')
      for (const p of parts) push('Participant', p.id, 'PARTICIPATES_IN')
      const creds = await db('ecs_credentials').where('subject_did', n.id).select('id')
      for (const c of creds) push('EcsCredential', c.id, 'SUBJECT_OF_CREDENTIAL')
      const services = await db('service_endpoints').where('did_id', n.id).select('id')
      for (const s of services) push('ServiceEndpoint', s.id, 'EXPOSES_SERVICE')
      const vps = await db('linked_vps').where('did_id', n.id).select('id')
      for (const v of vps) push('LinkedVerifiablePresentation', v.id, 'REFERENCES_VP')
      break
    }
    case 'Corporation': {
      const dids = await db('dids').where('corporation_id', n.id).select('did')
      for (const d of dids) push('Did', d.did, 'OPERATED_BY')
      const ecos = await db('ecosystems').where('corporation_id', n.id).select('id')
      for (const e of ecos) push('Ecosystem', e.id, 'CONTROLS')
      const parts = await db('participants').where('corporation_id', n.id).select('id')
      for (const p of parts) push('Participant', p.id, 'OWNED_BY_CORPORATION')
      break
    }
    case 'Ecosystem': {
      const eco = await db('ecosystems').where('id', n.id).first()
      if (eco) {
        push('Corporation', eco.corporation_id, 'CONTROLS')
        for (const s of eco.credential_schema_ids) push('CredentialSchema', Number(s), 'OWNS_SCHEMA')
      }
      for (const [table, type] of CREDENTIAL_TABLES) {
        const creds = await db(table).where('ecosystem_id', n.id).select('id')
        for (const c of creds) push(type, c.id, 'GOVERNED_BY')
      }
      break
    }
    case 'CredentialSchema': {
      const owners = await db('ecosystems').whereRaw('? = any(credential_schema_ids)', [n.id]).select('id')
      for (const e of owners) push('Ecosystem', e.id, 'OWNS_SCHEMA')
      const parts = await db('participants').where('credential_schema_id', n.id).select('id')
      for (const p of parts) push('Participant', p.id, 'FOR_SCHEMA')
      for (const [table, type] of CREDENTIAL_TABLES) {
        const creds = await db(table).where('credential_schema_id', n.id).select('id')
        for (const c of creds) push(type, c.id, 'BASED_ON_SCHEMA')
      }
      break
    }
    case 'Participant': {
      const p = await db('participants').where('id', n.id).first()
      if (p) {
        push('Did', p.did_id, 'PARTICIPATES_IN')
        push('Corporation', p.corporation_id, 'OWNED_BY_CORPORATION')
        push('CredentialSchema', p.credential_schema_id, 'FOR_SCHEMA')
        push('Participant', p.validator_participant_id, 'VALIDATED_BY')
      }
      const children = await db('participants').where('validator_participant_id', n.id).select('id')
      for (const c of children) push('Participant', c.id, 'VALIDATED_BY')
      for (const [table, type] of CREDENTIAL_TABLES) {
        const issued = await db(table).where('issuer_participant_id', n.id).select('id')
        for (const c of issued) push(type, c.id, 'ISSUED_BY')
        const held = await db(table).where('participant_id', n.id).select('id')
        for (const c of held) push(type, c.id, 'HELD_AS')
      }
      break
    }
    case 'EcsCredential':
    case 'Vtc': {
      const table = n.type === 'Vtc' ? 'vtcs' : 'ecs_credentials'
      const c = await db(table).where('id', n.id).first()
      if (c) {
        if (n.type === 'EcsCredential') push('Did', c.subject_did, 'SUBJECT_OF_CREDENTIAL')
        push('Participant', c.issuer_participant_id, 'ISSUED_BY')
        push('Participant', c.participant_id, 'HELD_AS')
        push('CredentialSchema', c.credential_schema_id, 'BASED_ON_SCHEMA')
        push('Ecosystem', c.ecosystem_id, 'GOVERNED_BY')
      }
      if (n.type === 'Vtc') {
        const vps = await db('lvp_vtcs').where('vtc_id', n.id).select('lvp_id')
        for (const v of vps) push('LinkedVerifiablePresentation', v.lvp_id, 'CONTAINS_VTC')
      }
      break
    }
    case 'LinkedVerifiablePresentation': {
      const vp = await db('linked_vps').where('id', n.id).first()
      if (vp) push('Did', vp.did_id, 'REFERENCES_VP')
      const vtcs = await db('lvp_vtcs').where('lvp_id', n.id).select('vtc_id')
      for (const v of vtcs) push('Vtc', v.vtc_id, 'CONTAINS_VTC')
      break
    }
    case 'ServiceEndpoint': {
      const se = await db('service_endpoints').where('id', n.id).first()
      if (se) push('Did', se.did_id, 'EXPOSES_SERVICE')
      break
    }
    default:
      break
  }
  return out
}
