import { readFileSync } from 'node:fs'
import { Ajv2020 as Ajv, ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { FastifyInstance } from 'fastify'
import { Knex } from 'knex'
import { ApiError } from '../errors'
import { isTrustExpired } from '../refs'
import { decodeCursor, encodeCursor, queryHash } from './cursor'
import { applyParticipantExists, normalizeFilterValue, resolveFieldSpec } from './registry'

type Surface = 'Did' | 'Ecosystem' | 'Corporation' | 'CredentialSchema' | 'ServiceEndpoint'

interface SearchRequest {
  surface: Surface
  filters?: Record<string, unknown>
  freeText?: string
  limit?: number
  cursor?: string | null
  includeUntrusted?: boolean
  includeArchived?: boolean
  snippet?: Record<string, boolean>
}

interface GroupDef {
  select?: (q: Knex.QueryBuilder) => void
  build: (row: Record<string, unknown>) => unknown
}

interface SurfaceDef {
  table: string
  alias: string
  pk: string
  // TG-FCT-5 ranking signals; direction is normative, weights are ours
  scoreExpr: string
  gates: (q: Knex.QueryBuilder, req: SearchRequest) => void
  coreSelect?: (q: Knex.QueryBuilder) => void
  core: (row: Record<string, unknown>) => Record<string, unknown>
  groups: Record<string, GroupDef>
  defaults: string[]
  defaultFacets: string[]
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))

const ENTRIES_CAP = 100

function service(r: Record<string, unknown>): Record<string, unknown> | null {
  if (r.sc_name == null) return null
  return {
    pattern: r.pattern ?? null,
    name: r.sc_name,
    type: r.sc_type ?? null,
    description: r.sc_description ?? null,
    logoUri: r.sc_logo_uri ?? null,
    logoDigestSri: r.sc_logo_digest_sri ?? null,
  }
}

function operator(r: Record<string, unknown>): Record<string, unknown> | null {
  if (r.operator_kind == null) return null
  return {
    kind: r.operator_kind,
    name: r.org_name ?? r.persona_name ?? null,
    logoUri: r.org_logo_uri ?? r.persona_avatar_uri ?? null,
    logoDigestSri: r.org_logo_digest_sri ?? r.persona_avatar_digest_sri ?? null,
    countryCode: r.org_country_code ?? r.persona_country_code ?? null,
    registryId: r.org_registry_id ?? null,
    address: r.org_address ?? null,
  }
}

function corporation(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.corporation_id ?? null,
    deposit: r.corp_deposit ?? null,
    slashedEvents: r.corp_slashed_events ?? null,
    lastSlashedAtTime: r.corp_last_slashed_at_time ? iso(r.corp_last_slashed_at_time) : null,
    slashedValue: r.corp_slashed_value ?? null,
  }
}

function governance(gf: unknown): Record<string, unknown> | null {
  if (!gf) return null
  const g = gf as { version: number; activeSince?: string | null; documents: unknown[] }
  return { version: g.version, activeSince: g.activeSince ?? null, documents: g.documents }
}

function stats(r: Record<string, unknown>): Record<string, unknown> {
  return {
    participants: r.participants ?? {},
    issuedCredentials: r.issued_credentials ?? 0,
    verifiedCredentials: r.verified_credentials ?? 0,
  }
}

function didCard(card: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!card) return null
  return {
    did: card.did,
    trusted: card.trusted,
    isTrustExpired: card.is_trust_expired,
    service: service(card),
    operator: operator(card),
  }
}

const CORP_SELECTS = [
  'corp.deposit as corp_deposit',
  'corp.slashed_events as corp_slashed_events',
  'corp.last_slashed_at_time as corp_last_slashed_at_time',
  'corp.slashed_value as corp_slashed_value',
]

function schemaRefs(idsExpr: string): string {
  return `(select coalesce(json_agg(json_build_object(
      'id', cs.id, 'title', cs.title, 'archived', cs.archived,
      'participants', coalesce(cs.participants, '{}'::jsonb)) order by cs.id), '[]'::json)
    from credential_schemas cs where cs.id = any(${idsExpr}))`
}

const DID_CARD_COLUMNS = [
  'did',
  'trusted',
  'pattern',
  'sc_name',
  'sc_type',
  'sc_description',
  'sc_logo_uri',
  'sc_logo_digest_sri',
  'operator_kind',
  'org_name',
  'org_logo_uri',
  'org_logo_digest_sri',
  'org_country_code',
  'org_registry_id',
  'org_address',
  'persona_name',
  'persona_avatar_uri',
  'persona_avatar_digest_sri',
  'persona_country_code',
]

function didCardSql(boundExpr: string): string {
  const columns = DID_CARD_COLUMNS.map(c => `'${c}', bd.${c}`).join(', ')
  return `(select jsonb_build_object(${columns},
      'is_trust_expired', bd.expires_at_time is not null and bd.expires_at_time < now())
    from dids bd where bd.did = ${boundExpr}) as g_did_card`
}

const DID_ENDPOINTS_SQL = `(select coalesce(json_agg(json_build_object(
    'id', se.id, 'type', se.type, 'serviceEndpoint', se.service_endpoint) order by se.id), '[]'::json)
  from service_endpoints se where se.did_id = d.did) as g_endpoints`

const DID_ECOSYSTEMS_SQL = `(select coalesce(json_agg(json_build_object(
    'id', ex.id, 'archived', ex.archived,
    'participants', coalesce(ex.participants, '{}'::jsonb),
    'schemas', ${schemaRefs('ex.credential_schema_ids')}) order by ex.id), '[]'::json)
  from ecosystems ex where ex.did = d.did) as g_ecosystems`

const DID_PARTICIPATIONS_SQL = `(select json_build_object(
    'total', count(*),
    'ecosystemCount', count(distinct p.ecosystem_id),
    'byRole', coalesce((select json_object_agg(r.role, r.n) from (
        select pr.role, count(*) as n from participants pr
        where pr.did_id = d.did and pr.state = 'ACTIVE' group by pr.role) r), '{}'::json),
    'entries', coalesce((select json_agg(json_build_object(
        'id', pe.id, 'role', pe.role, 'credentialSchemaId', pe.credential_schema_id,
        'schemaTitle', cs.title, 'ecosystemId', pe.ecosystem_id) order by pe.id)
      from (select * from participants pi where pi.did_id = d.did and pi.state = 'ACTIVE'
            order by pi.id limit ?) pe
      left join credential_schemas cs on cs.id = pe.credential_schema_id), '[]'::json))
  from participants p where p.did_id = d.did and p.state = 'ACTIVE') as g_participations`

const DID_VTC_IDS_SQL = `select lv.vtc_id from lvp_vtcs lv join linked_vps l on l.id = lv.lvp_id where l.did_id = d.did`

const DID_CREDENTIALS_SQL = `(select json_build_object(
    'total', count(*),
    'entries', coalesce((select json_agg(json_build_object(
        'id', ve.id, 'credentialSchemaId', ve.credential_schema_id, 'schemaTitle', cs.title,
        'ecosystemId', ve.ecosystem_id, 'attributes', ve.credential_subject - 'id') order by ve.id)
      from (select * from vtcs vi where vi.id in (${DID_VTC_IDS_SQL}) order by vi.id limit ?) ve
      left join credential_schemas cs on cs.id = ve.credential_schema_id), '[]'::json))
  from vtcs v where v.id in (${DID_VTC_IDS_SQL})) as g_credentials`

const CORP_ECOSYSTEMS_SQL = `(select json_build_object(
    'total', count(*),
    'entries', coalesce((select json_agg(json_build_object('id', ce.id, 'archived', ce.archived) order by ce.id)
      from (select * from ecosystems ci where ci.corporation_id = c.id order by ci.id limit ?) ce), '[]'::json))
  from ecosystems ce0 where ce0.corporation_id = c.id) as g_ecosystems`

const CORP_DIDS_SQL = `(select json_build_object(
    'total', count(*),
    'entries', coalesce((select json_agg(json_build_object(
        'did', od.did, 'trusted', od.trusted,
        'isTrustExpired', od.expires_at_time is not null and od.expires_at_time < now()) order by od.did)
      from (select * from dids oi where oi.corporation_id = c.id order by oi.did limit ?) od), '[]'::json))
  from dids od0 where od0.corporation_id = c.id) as g_dids`

const SURFACES: Record<Surface, SurfaceDef> = {
  Did: {
    table: 'dids',
    alias: 'd',
    pk: 'd.did',
    scoreExpr: `
      coalesce(ln(1 + coalesce(corp.deposit_amount, 0) / 1000000.0) * 0.5, 0)
      - coalesce(corp.slashed_events, 0) * 0.5
      + extract(epoch from d.last_observed_at_time) / 1e12`,
    gates(q, req) {
      // Did.trusted = true is overridable; the trust-expiry gate never is (TG-FCT-2)
      if (!req.includeUntrusted) q.where('d.trusted', true)
      q.where(qb =>
        qb.whereNull('d.expires_at_time').orWhere('d.expires_at_time', '>=', new Date().toISOString()),
      )
    },
    coreSelect(q) {
      q.select(
        q.client.raw(`exists(select 1 from corporations cx where cx.did = d.did) as is_corporation`),
        q.client.raw(`exists(select 1 from ecosystems ex where ex.did = d.did) as is_ecosystem`),
      )
    },
    core: r => ({
      did: r.did,
      lastObservedAtTime: iso(r.last_observed_at_time),
      isTrustExpired: isTrustExpired({ expires_at_time: r.expires_at_time as Date | null }),
      trusted: r.trusted,
      isCorporation: Boolean(r.is_corporation),
      isEcosystem: Boolean(r.is_ecosystem),
    }),
    groups: {
      service: { build: service },
      operator: { build: operator },
      corporation: { select: q => q.select(CORP_SELECTS), build: corporation },
      endpoints: { select: q => q.select(q.client.raw(DID_ENDPOINTS_SQL)), build: r => r.g_endpoints ?? [] },
      ecosystems: {
        select: q => q.select(q.client.raw(DID_ECOSYSTEMS_SQL)),
        build: r => r.g_ecosystems ?? [],
      },
      participations: {
        select: q => q.select(q.client.raw(DID_PARTICIPATIONS_SQL, [ENTRIES_CAP])),
        build: r => r.g_participations,
      },
      credentials: {
        select: q => q.select(q.client.raw(DID_CREDENTIALS_SQL, [ENTRIES_CAP])),
        build: r => r.g_credentials,
      },
    },
    defaults: ['service', 'operator', 'corporation', 'endpoints'],
    defaultFacets: [
      'Did.operatorKind',
      'EcsCredential.ServiceCredential.type',
      'OrganizationCredential.countryCode',
    ],
  },
  Ecosystem: {
    table: 'ecosystems',
    alias: 'e',
    pk: 'e.id',
    scoreExpr: `
      ln(1 + coalesce(e.issued_credentials, 0) + coalesce(e.verified_credentials, 0)) * 0.3
      + extract(epoch from e.last_observed_at_time) / 1e12`,
    gates(q, req) {
      if (!req.includeArchived) q.where('e.archived', false)
      // hidden when the controlling DID is trust-expired, never overridable (TG-FCT-2/TG-ACT-3)
      q.whereNotExists(function () {
        this.select(1)
          .from('dids as dx')
          .whereRaw('dx.did = e.did')
          .where('dx.expires_at_time', '<', new Date().toISOString())
      })
    },
    core: r => ({
      id: r.id,
      did: r.did,
      archived: r.archived,
      lastObservedAtTime: iso(r.last_observed_at_time),
    }),
    groups: {
      corporation: {
        select: q => q.leftJoin('corporations as corp', 'corp.id', 'e.corporation_id').select(CORP_SELECTS),
        build: corporation,
      },
      stats: { build: stats },
      governance: { build: r => governance(r.egf) },
      schemas: {
        select: q => q.select(q.client.raw(`${schemaRefs('e.credential_schema_ids')} as g_schemas`)),
        build: r => r.g_schemas ?? [],
      },
      didCard: {
        select: q => q.select(q.client.raw(didCardSql('e.did'))),
        build: r => didCard(r.g_did_card as Record<string, unknown> | null),
      },
    },
    defaults: ['corporation', 'stats', 'didCard'],
    defaultFacets: ['archived', 'corporationId'],
  },
  Corporation: {
    table: 'corporations',
    alias: 'c',
    pk: 'c.id',
    scoreExpr: `
      coalesce(ln(1 + coalesce(c.deposit_amount, 0) / 1000000.0) * 0.5, 0)
      - c.slashed_events * 0.5
      + extract(epoch from c.last_observed_at_time) / 1e12`,
    gates(q) {
      q.whereNotExists(function () {
        this.select(1)
          .from('dids as dx')
          .whereRaw('dx.did = c.did')
          .where('dx.expires_at_time', '<', new Date().toISOString())
      })
    },
    core: r => ({
      id: r.id,
      did: r.did,
      lastObservedAtTime: iso(r.last_observed_at_time),
    }),
    groups: {
      trust: {
        build: r => ({
          policyAddress: r.policy_address ?? null,
          deposit: r.deposit ?? null,
          slashedEvents: r.slashed_events,
          lastSlashedAtTime: r.last_slashed_at_time ? iso(r.last_slashed_at_time) : null,
          slashedValue: r.slashed_value ?? null,
        }),
      },
      governance: { build: r => governance(r.cgf) },
      ecosystems: {
        select: q => q.select(q.client.raw(CORP_ECOSYSTEMS_SQL, [ENTRIES_CAP])),
        build: r => r.g_ecosystems,
      },
      dids: { select: q => q.select(q.client.raw(CORP_DIDS_SQL, [ENTRIES_CAP])), build: r => r.g_dids },
      didCard: {
        select: q => q.select(q.client.raw(didCardSql('c.did'))),
        build: r => didCard(r.g_did_card as Record<string, unknown> | null),
      },
    },
    defaults: ['trust', 'didCard'],
    defaultFacets: [],
  },
  CredentialSchema: {
    table: 'credential_schemas',
    alias: 'cs',
    pk: 'cs.id',
    scoreExpr: `
      ln(1 + coalesce(cs.issued_credentials, 0) + coalesce(cs.verified_credentials, 0)) * 0.3
      + extract(epoch from cs.last_observed_at_time) / 1e12`,
    gates(q, req) {
      if (!req.includeArchived) q.where('cs.archived', false)
    },
    core: r => ({
      id: r.id,
      archived: r.archived,
      lastObservedAtTime: iso(r.last_observed_at_time),
    }),
    groups: {
      schema: {
        build: r => ({
          type: r.type,
          digestSri: r.digest_sri,
          title: r.title ?? null,
          description: r.description ?? null,
        }),
      },
      ecosystem: {
        select: q =>
          q.leftJoin('ecosystems as oe', 'oe.id', 'cs.ecosystem_id').select('oe.archived as eco_archived'),
        build: r => ({ id: r.ecosystem_id, archived: Boolean(r.eco_archived) }),
      },
      stats: { build: stats },
      body: { build: r => r.body },
    },
    defaults: ['schema', 'ecosystem'],
    defaultFacets: ['archived', 'ecosystemId'],
  },
  ServiceEndpoint: {
    table: 'service_endpoints',
    alias: 'se',
    pk: 'se.id',
    scoreExpr: 'extract(epoch from se.last_observed_at_time) / 1e12',
    gates(q, req) {
      // hits mirror the owning DID's gates (TG-FCT-2)
      q.whereExists(function () {
        this.select(1)
          .from('dids as dx')
          .whereRaw('dx.did = se.did_id')
          .where(qb =>
            qb.whereNull('dx.expires_at_time').orWhere('dx.expires_at_time', '>=', new Date().toISOString()),
          )
        if (!req.includeUntrusted) this.where('dx.trusted', true)
      })
    },
    core: r => ({
      id: r.id,
      didId: r.did_id,
      type: r.type,
      serviceEndpoint: r.service_endpoint,
      lastObservedAtTime: iso(r.last_observed_at_time),
    }),
    groups: {
      didCard: {
        select: q => q.select(q.client.raw(didCardSql('se.did_id'))),
        build: r => didCard(r.g_did_card as Record<string, unknown> | null),
      },
    },
    defaults: ['didCard'],
    defaultFacets: ['type'],
  },
}

function compileRequestSchema(): ValidateFunction {
  const schemaPath = new URL('../../../spec/graph/search.request.schema.json', import.meta.url)
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv({ strict: false })
  addFormats.default(ajv as never)
  return ajv.compile(schema)
}

export function registerSearchRoute(app: FastifyInstance, db: Knex): void {
  const validate = compileRequestSchema()

  app.post('/v4/graph/search', async (request, reply) => {
    const req = request.body as SearchRequest
    if (!validate(req)) {
      const detail = (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')
      throw new ApiError('INVALID_INPUT', `request does not match search schema: ${detail}`)
    }
    const def = SURFACES[req.surface]
    const wanted = req.snippet
      ? Object.keys(req.snippet).filter(k => req.snippet?.[k] === true)
      : def.defaults
    const groups = Object.entries(def.groups).filter(([name]) => wanted.includes(name))
    const freeText = req.freeText?.trim() || undefined
    const limit = req.limit ?? 20
    const hash = queryHash(req as unknown as Record<string, unknown>)

    const base = () => {
      const q = db(`${def.table} as ${def.alias}`)
      if (req.surface === 'Did') {
        q.leftJoin('corporations as corp', 'corp.id', 'd.corporation_id')
      }
      def.gates(q, req)
      const facetSpecs: [string, NonNullable<ReturnType<typeof resolveFieldSpec>['facet']>][] = []
      for (const [field, raw] of Object.entries(req.filters ?? {})) {
        const spec = resolveFieldSpec(req.surface, field)
        const norm = normalizeFilterValue(field, raw)
        if (!spec.ops.includes(norm.op)) {
          throw new ApiError(
            'INVALID_INPUT',
            `operator ${norm.op} is not supported on ${field} (allowed: ${spec.ops.join(', ')})`,
          )
        }
        spec.apply(q, norm)
        if (spec.facet && (norm.op === 'eq' || norm.op === 'in')) facetSpecs.push([field, spec.facet])
      }
      if (req.surface === 'Did') applyParticipantExists(q, db)
      if (freeText) {
        q.whereRaw(
          `(numnode(plainto_tsquery('simple', search_tokens(?))) = 0 OR ${def.alias}.search_vec @@ plainto_tsquery('simple', search_tokens(?)))`,
          [freeText, freeText],
        )
      }
      return { q, facetSpecs }
    }

    // float8 end to end: NUMERIC scores round-trip through JS as lossy strings and break the
    // keyset boundary comparison
    const scoreSelect = freeText
      ? `(ts_rank(${def.alias}.search_vec, plainto_tsquery('simple', search_tokens(?))) * 10 + ${def.scoreExpr})::float8`
      : `(${def.scoreExpr})::float8`
    const scoreBindings = freeText ? [freeText] : []

    const { q: hitsQuery, facetSpecs } = base()
    for (const field of def.defaultFacets) {
      if (facetSpecs.some(([f]) => f === field)) continue
      const spec = resolveFieldSpec(req.surface, field)
      if (spec.facet) facetSpecs.push([field, spec.facet])
    }
    hitsQuery.select(`${def.alias}.*`).select(db.raw(`${scoreSelect} as _score`, scoreBindings))
    def.coreSelect?.(hitsQuery)
    for (const [, g] of groups) g.select?.(hitsQuery)
    if (req.cursor !== undefined && req.cursor !== null) {
      const c = decodeCursor(req.cursor, hash)
      hitsQuery.whereRaw(`(${scoreSelect} < ? OR (${scoreSelect} = ? AND ${def.pk} > ?))`, [
        ...scoreBindings,
        c.s,
        ...scoreBindings,
        c.s,
        c.k,
      ])
    }
    hitsQuery
      .orderBy([
        { column: '_score', order: 'desc' },
        { column: def.pk, order: 'asc' },
      ])
      .limit(limit)

    const countQuery = base().q.clearSelect().count('* as n').first()
    const [rows, countRow, ...facetRows] = await Promise.all([
      hitsQuery as Promise<Record<string, unknown>[]>,
      countQuery as unknown as Promise<{ n: string | number }>,
      ...facetSpecs.map(
        ([, facetFn]) => facetFn(base().q, db) as Promise<{ value: unknown; count: string | number }[]>,
      ),
    ])
    const totalCount = Number(countRow.n)

    const facets: Record<string, { value: unknown; count: number }[]> = {}
    facetSpecs.forEach(([field], i) => {
      facets[field] = (facetRows[i] ?? []).map(r => ({ value: r.value, count: Number(r.count) }))
    })

    const hits = rows.map(r => ({
      type: req.surface,
      id: (req.surface === 'Did' ? r.did : req.surface === 'ServiceEndpoint' ? r.id : Number(r.id)) as
        | string
        | number,
      score: Math.max(0, Number(r._score)),
      snippet: Object.assign(def.core(r), Object.fromEntries(groups.map(([name, g]) => [name, g.build(r)]))),
    }))

    const last = rows[rows.length - 1]
    const cursor =
      rows.length === limit && last
        ? encodeCursor(Number(last._score), String(req.surface === 'Did' ? last.did : last.id), hash)
        : null

    return reply.send({ query: req, totalCount, hits, facets, cursor })
  })
}
