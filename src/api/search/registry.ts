import { Ajv2020 as Ajv } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { Knex } from 'knex'
import { ApiError } from '../errors'

export type Operator = 'eq' | 'in' | 'range' | 'prefix' | 'contains' | 'containsAny'

export interface RangeValue {
  gt?: number | string
  gte?: number | string
  lt?: number | string
  lte?: number | string
}

export interface NormalizedFilter {
  op: Operator
  value: unknown
}

// TG-FCT-3: bare scalar = eq, bare array = in, otherwise an operator object
export function normalizeFilterValue(field: string, raw: unknown): NormalizedFilter {
  if (Array.isArray(raw)) return { op: 'in', value: raw }
  if (raw !== null && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>)
    if (entries.length !== 1) {
      throw new ApiError('INVALID_INPUT', `filter ${field} must carry exactly one operator`)
    }
    const [op, value] = entries[0] as [string, unknown]
    if (!['eq', 'in', 'range', 'prefix', 'contains', 'containsAny'].includes(op)) {
      throw new ApiError('INVALID_INPUT', `unknown operator ${op} on ${field}`)
    }
    return { op: op as Operator, value }
  }
  return { op: 'eq', value: raw }
}

export type OperandType = 'string' | 'boolean' | 'int' | 'bigint' | 'dateTime'

export interface FieldSpec {
  ops: Operator[]
  type: OperandType
  apply: (q: Knex.QueryBuilder, f: NormalizedFilter) => void
  // facet aggregation for eq/in fields (TG-FCT-6)
  facet: ((base: Knex.QueryBuilder, db: Knex) => Knex.QueryBuilder) | null
}

const ajv = new Ajv({ strict: false })
addFormats.default(ajv as never)
const isDateTime = ajv.compile({ type: 'string', format: 'date-time' })

function isInteger(v: unknown, max: number): boolean {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max
}

const OPERANDS: Record<OperandType, { label: string; accepts: (v: unknown) => boolean }> = {
  string: { label: 'a string', accepts: v => typeof v === 'string' },
  boolean: { label: 'true or false', accepts: v => typeof v === 'boolean' },
  int: { label: 'an integer from 0 to 2147483647', accepts: v => isInteger(v, 2147483647) },
  bigint: { label: 'a non-negative integer', accepts: v => isInteger(v, Number.MAX_SAFE_INTEGER) },
  // Postgres has no year 0
  dateTime: {
    label: 'an ISO 8601 date-time',
    accepts: v => isDateTime(v) && !(v as string).startsWith('0000'),
  },
}

export function assertOperandTypes(field: string, spec: FieldSpec, f: NormalizedFilter): void {
  const values =
    f.op === 'range' ? Object.values(f.value as RangeValue) : Array.isArray(f.value) ? f.value : [f.value]
  const operand = OPERANDS[spec.type]
  for (const v of values) {
    if (!operand.accepts(v)) {
      throw new ApiError(
        'INVALID_INPUT',
        `filter ${field} expects ${operand.label}, got ${JSON.stringify(v)}`,
      )
    }
  }
}

function scalarColumn(col: string): Pick<FieldSpec, 'apply'> {
  return {
    apply(q, f) {
      if (f.op === 'eq') q.where(col, f.value as string)
      else if (f.op === 'in') q.whereIn(col, f.value as string[])
      else if (f.op === 'prefix') q.where(col, 'like', `${String(f.value)}%`)
      else if (f.op === 'range') applyRange(q, col, f.value as RangeValue)
    },
  }
}

function applyRange(q: Knex.QueryBuilder, col: string, r: RangeValue): void {
  if (r.gt !== undefined) q.where(col, '>', r.gt)
  if (r.gte !== undefined) q.where(col, '>=', r.gte)
  if (r.lt !== undefined) q.where(col, '<', r.lt)
  if (r.lte !== undefined) q.where(col, '<=', r.lte)
}

// TG-FCT-6 requires a facet for every eq/in filter, including the derived ones
function expressionFacet(sql: string) {
  return (base: Knex.QueryBuilder, db: Knex): Knex.QueryBuilder =>
    base
      .clone()
      .clearSelect()
      .clearOrder()
      .select(db.raw(`${sql} as value`))
      .count('* as count')
      .groupBy(db.raw(sql))
      .orderBy('count', 'desc')
      .limit(20)
}

function columnFacet(col: string, alias = col) {
  return (base: Knex.QueryBuilder): Knex.QueryBuilder =>
    base
      .clone()
      .clearSelect()
      .clearOrder()
      .select({ value: alias })
      .count('* as count')
      .whereNotNull(alias)
      .groupBy(alias)
      .orderBy('count', 'desc')
      .limit(20)
}

function spec(col: string, type: OperandType, ops: Operator[], facetCol?: string | null): FieldSpec {
  return {
    ops,
    type,
    ...scalarColumn(col),
    facet: facetCol === null ? null : columnFacet(facetCol ?? col),
  }
}

export const DID_FILTERS: Record<string, FieldSpec> = {
  'Did.trusted': spec('d.trusted', 'boolean', ['eq'], 'd.trusted'),
  'Did.pattern': spec('d.pattern', 'string', ['eq', 'in'], 'd.pattern'),
  'Did.serviceTypes': {
    ops: ['contains', 'containsAny'],
    type: 'string',
    apply(q, f) {
      if (f.op === 'contains') q.whereRaw('d.service_types @> ARRAY[?]::text[]', [String(f.value)])
      else q.whereRaw('d.service_types && ?::text[]', [f.value as string[]])
    },
    facet: (base, db) =>
      db
        .from(base.clone().clearSelect().clearOrder().select('d.service_types').as('sub'))
        .select(db.raw('unnest(sub.service_types) as value'))
        .count('* as count')
        .groupBy('value')
        .orderBy('count', 'desc')
        .limit(20),
  },
  'Did.corporationId': spec('d.corporation_id', 'bigint', ['eq'], 'd.corporation_id'),
  'Did.isCorporation': {
    ops: ['eq'],
    type: 'boolean',
    apply(q, f) {
      q.whereRaw(`exists(select 1 from corporations cf where cf.did = d.did) = ?`, [f.value as boolean])
    },
    facet: expressionFacet('exists(select 1 from corporations cf where cf.did = d.did)'),
  },
  'Did.isEcosystem': {
    ops: ['eq'],
    type: 'boolean',
    apply(q, f) {
      q.whereRaw(`exists(select 1 from ecosystems ef where ef.did = d.did) = ?`, [f.value as boolean])
    },
    facet: expressionFacet('exists(select 1 from ecosystems ef where ef.did = d.did)'),
  },
  'Did.ecosystemIds': {
    ops: ['contains', 'containsAny'],
    type: 'bigint',
    apply(q, f) {
      const ids = (f.op === 'contains' ? [f.value] : (f.value as unknown[])).map(Number)
      const sql = f.op === 'contains' ? 'array_agg(ef.id) @> ?::bigint[]' : 'array_agg(ef.id) && ?::bigint[]'
      q.whereRaw(`(select coalesce(${sql}, false) from ecosystems ef where ef.did = d.did)`, [ids])
    },
    facet: null,
  },
  'Did.operatorKind': spec('d.operator_kind', 'string', ['eq', 'in'], 'd.operator_kind'),
  // TG-FCT-3: one derived field matching the operatorName of the snippet, so a client
  // filtering by operator name never has to branch on operatorKind
  'Did.operatorName': {
    ops: ['eq', 'in', 'prefix'],
    type: 'string',
    apply(q, f) {
      if (f.op === 'eq') q.whereRaw('coalesce(d.org_name, d.persona_name) = ?', [f.value as string])
      else if (f.op === 'in')
        q.whereRaw('coalesce(d.org_name, d.persona_name) = any(?)', [f.value as string[]])
      else q.whereRaw('coalesce(d.org_name, d.persona_name) like ?', [`${String(f.value)}%`])
    },
    facet: expressionFacet('coalesce(d.org_name, d.persona_name)'),
  },
  'EcsCredential.ServiceCredential.type': spec('d.sc_type', 'string', ['eq', 'in'], 'd.sc_type'),
  'EcsCredential.ServiceCredential.minimumAgeRequired': spec('d.min_age', 'int', ['range'], null),
  'OrganizationCredential.countryCode': spec(
    'd.org_country_code',
    'string',
    ['eq', 'in'],
    'd.org_country_code',
  ),
  'OrganizationCredential.legalJurisdiction': spec(
    'd.org_legal_jurisdiction',
    'string',
    ['eq', 'in', 'prefix'],
    'd.org_legal_jurisdiction',
  ),
  'OrganizationCredential.organizationKind': spec(
    'd.org_organization_kind',
    'string',
    ['eq', 'in'],
    'd.org_organization_kind',
  ),
  'OrganizationCredential.lei': spec('d.org_lei', 'string', ['eq'], 'd.org_lei'),
  'OrganizationCredential.registryId': spec('d.org_registry_id', 'string', ['eq'], 'd.org_registry_id'),
  'PersonaCredential.controllerCountryCode': spec(
    'd.persona_country_code',
    'string',
    ['eq', 'in'],
    'd.persona_country_code',
  ),
  'PersonaCredential.controllerJurisdiction': spec(
    'd.persona_jurisdiction',
    'string',
    ['eq', 'in', 'prefix'],
    'd.persona_jurisdiction',
  ),
  // Participant.* filters correlate on the SAME participant row (gap filed against TG-FCT-3)
  'Participant.ecosystemId': participantFilter('ecosystem_id', 'bigint'),
  'Participant.credentialSchemaId': participantFilter('credential_schema_id', 'bigint'),
  'Participant.role': participantFilter('role', 'string'),
}

interface ParticipantConstraints {
  ecosystem_id?: NormalizedFilter
  credential_schema_id?: NormalizedFilter
  role?: NormalizedFilter
}

// collected per request, applied as one EXISTS
export const participantConstraintsKey = Symbol('participantConstraints')

function participantFilter(col: keyof ParticipantConstraints, type: OperandType): FieldSpec {
  return {
    ops: ['eq', 'in'],
    type,
    apply(q, f) {
      const store = (q as unknown as Record<symbol, ParticipantConstraints>)[participantConstraintsKey] ?? {}
      store[col] = f
      ;(q as unknown as Record<symbol, ParticipantConstraints>)[participantConstraintsKey] = store
    },
    facet: (base, db) =>
      db
        .from(base.clone().clearSelect().clearOrder().select('d.did').as('sub'))
        .join('participants as pf', 'pf.did_id', 'sub.did')
        .where('pf.state', 'ACTIVE')
        .select({ value: `pf.${col}` })
        .countDistinct('sub.did as count')
        .groupBy(`pf.${col}`)
        .orderBy('count', 'desc')
        .limit(20),
  }
}

export function applyParticipantExists(q: Knex.QueryBuilder, db: Knex): void {
  const store = (q as unknown as Record<symbol, ParticipantConstraints>)[participantConstraintsKey]
  if (!store) return
  q.whereExists(function () {
    this.select(1).from('participants as pf').whereRaw('pf.did_id = d.did').where('pf.state', 'ACTIVE')
    for (const [col, f] of Object.entries(store) as [string, NormalizedFilter][]) {
      if (f.op === 'eq') this.where(`pf.${col}`, f.value as string)
      else this.whereIn(`pf.${col}`, f.value as string[])
    }
  })
  void db
}

export const ECOSYSTEM_FILTERS: Record<string, FieldSpec> = {
  archived: spec('e.archived', 'boolean', ['eq'], 'e.archived'),
  issuedCredentials: spec('e.issued_credentials', 'bigint', ['range'], null),
  verifiedCredentials: spec('e.verified_credentials', 'bigint', ['range'], null),
  corporationId: spec('e.corporation_id', 'bigint', ['eq'], 'e.corporation_id'),
}

export const CORPORATION_FILTERS: Record<string, FieldSpec> = {
  deposit: spec('c.deposit_amount', 'bigint', ['range'], null),
  slashedEvents: spec('c.slashed_events', 'int', ['range'], null),
  lastSlashedAtTime: spec('c.last_slashed_at_time', 'dateTime', ['range'], null),
}

export const SCHEMA_FILTERS: Record<string, FieldSpec> = {
  archived: spec('cs.archived', 'boolean', ['eq'], 'cs.archived'),
  ecosystemId: spec('cs.ecosystem_id', 'bigint', ['eq', 'in'], 'cs.ecosystem_id'),
  issuedCredentials: spec('cs.issued_credentials', 'bigint', ['range'], null),
  verifiedCredentials: spec('cs.verified_credentials', 'bigint', ['range'], null),
}

export const SERVICE_ENDPOINT_FILTERS: Record<string, FieldSpec> = {
  type: spec('se.type', 'string', ['eq', 'in'], 'se.type'),
}

const PARTICIPANTS_ROLE_RE =
  /^participants\[(HOLDER|ISSUER|VERIFIER|ISSUER_GRANTOR|VERIFIER_GRANTOR|ECOSYSTEM)\]$/

export function resolveFieldSpec(surface: string, field: string): FieldSpec {
  const table: Record<string, Record<string, FieldSpec>> = {
    Did: DID_FILTERS,
    Ecosystem: ECOSYSTEM_FILTERS,
    Corporation: CORPORATION_FILTERS,
    CredentialSchema: SCHEMA_FILTERS,
    ServiceEndpoint: SERVICE_ENDPOINT_FILTERS,
  }
  const registry = table[surface]
  if (!registry) throw new ApiError('INVALID_INPUT', `unknown surface ${surface}`)
  const found = Object.hasOwn(registry, field) ? registry[field] : undefined
  if (found) return found
  if (surface === 'Ecosystem') {
    const m = field.match(PARTICIPANTS_ROLE_RE)
    if (m) {
      const role = m[1] as string
      return {
        ops: ['range'],
        type: 'bigint',
        apply(q, f) {
          if (f.op === 'range') {
            const r = f.value as RangeValue
            const expr = `(e.participants->>'${role}')::bigint`
            if (r.gt !== undefined) q.whereRaw(`${expr} > ?`, [r.gt])
            if (r.gte !== undefined) q.whereRaw(`${expr} >= ?`, [r.gte])
            if (r.lt !== undefined) q.whereRaw(`${expr} < ?`, [r.lt])
            if (r.lte !== undefined) q.whereRaw(`${expr} <= ?`, [r.lte])
          }
        },
        facet: null,
      }
    }
  }
  throw new ApiError('UNKNOWN_FILTER_FIELD', `field ${field} is not filterable on the ${surface} surface`)
}
