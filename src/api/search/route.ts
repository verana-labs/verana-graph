import { readFileSync } from 'node:fs'
import { Ajv2020 as Ajv, ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { FastifyInstance } from 'fastify'
import { Knex } from 'knex'
import { Config } from '../../config'
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
}

interface SurfaceDef {
  table: string
  alias: string
  pk: string
  hasVec: boolean
  // TG-FCT-5 ranking signals; direction is normative, weights are ours
  scoreExpr: string
  gates: (q: Knex.QueryBuilder, req: SearchRequest, config: Config) => void
  // hits-query-only joins for card fields; never applied to counts or facets
  enrich?: (q: Knex.QueryBuilder) => void
  snippet: (row: Record<string, unknown>) => Record<string, unknown>
}

const strip = (o: Record<string, unknown>) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))

const SURFACES: Record<Surface, SurfaceDef> = {
  Did: {
    table: 'dids',
    alias: 'd',
    pk: 'd.did',
    hasVec: true,
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
    enrich(q) {
      q.select(
        q.client.raw(`(
          select coalesce(json_agg(json_build_object(
            'id', se.id, 'type', se.type, 'serviceEndpoint', se.service_endpoint
          ) order by se.id), '[]'::json)
          from service_endpoints se where se.did_id = d.did
        ) as service_endpoints`),
        q.client.raw(`(
          select coalesce(json_agg(e.id order by e.id), '[]'::json)
          from ecosystems e where e.did = d.did
        ) as ecosystem_ids`),
        q.client.raw(`exists(select 1 from corporations cx where cx.did = d.did) as is_corporation`),
      )
    },
    // TG-FCT-6a: every field is present on every hit, null when it has no value
    snippet: r => ({
      did: r.did,
      lastObservedAtTime: iso(r.last_observed_at_time),
      isTrustExpired: isTrustExpired({ expires_at_time: r.expires_at_time as Date | null }),
      trusted: r.trusted,
      pattern: r.pattern ?? null,
      operatorKind: r.operator_kind ?? null,
      serviceName: r.sc_name ?? null,
      serviceType: r.sc_type ?? null,
      serviceDescription: r.sc_description ?? null,
      serviceLogoUri: r.sc_logo_uri ?? null,
      serviceLogoDigestSri: r.sc_logo_digest_sri ?? null,
      operatorName: r.org_name ?? r.persona_name ?? null,
      operatorLogoUri: r.org_logo_uri ?? r.persona_avatar_uri ?? null,
      operatorLogoDigestSri: r.org_logo_digest_sri ?? r.persona_avatar_digest_sri ?? null,
      operatorCountryCode: r.org_country_code ?? r.persona_country_code ?? null,
      corporationId: r.corporation_id,
      corporationDeposit: r.corp_deposit ?? null,
      corporationSlashedEvents: r.corp_slashed_events ?? null,
      corporationLastSlashedAtTime: r.corp_last_slashed_at_time ? iso(r.corp_last_slashed_at_time) : null,
      corporationSlashedValue: r.corp_slashed_value ?? null,
      serviceEndpoints: r.service_endpoints ?? [],
      isCorporation: Boolean(r.is_corporation),
      isEcosystem: ((r.ecosystem_ids as number[] | null) ?? []).length > 0,
      ecosystemIds: (r.ecosystem_ids as number[] | null) ?? [],
    }),
  },
  Ecosystem: {
    table: 'ecosystems',
    alias: 'e',
    pk: 'e.id',
    hasVec: true,
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
    snippet: r =>
      strip({
        id: r.id,
        did: r.did,
        archived: r.archived,
        lastObservedAtTime: iso(r.last_observed_at_time),
        corporationId: r.corporation_id,
      }),
  },
  Corporation: {
    table: 'corporations',
    alias: 'c',
    pk: 'c.id',
    hasVec: true,
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
    snippet: r =>
      strip({
        id: r.id,
        did: r.did,
        lastObservedAtTime: iso(r.last_observed_at_time),
        policyAddress: r.policy_address ?? undefined,
        deposit: r.deposit ?? undefined,
        slashedEvents: r.slashed_events,
      }),
  },
  CredentialSchema: {
    table: 'credential_schemas',
    alias: 'cs',
    pk: 'cs.id',
    hasVec: true,
    scoreExpr: `
      ln(1 + coalesce(cs.issued_credentials, 0) + coalesce(cs.verified_credentials, 0)) * 0.3
      + extract(epoch from cs.last_observed_at_time) / 1e12`,
    gates(q, req) {
      if (!req.includeArchived) q.where('cs.archived', false)
    },
    snippet: r =>
      strip({
        id: r.id,
        archived: r.archived,
        lastObservedAtTime: iso(r.last_observed_at_time),
        type: r.type,
        digestSri: r.digest_sri ?? undefined,
        ecosystemId: r.ecosystem_id,
        title: r.title ?? undefined,
        description: r.description ?? undefined,
      }),
  },
  ServiceEndpoint: {
    table: 'service_endpoints',
    alias: 'se',
    pk: 'se.id',
    hasVec: false,
    scoreExpr: 'extract(epoch from se.last_observed_at_time) / 1e12',
    gates(q, _req, config) {
      // ungated per spec-as-written; the flag applies owner gates pending the filed
      // ServiceEndpoint-gate issue on verana-spec
      if (config.gateServiceEndpoints) {
        q.whereExists(function () {
          this.select(1)
            .from('dids as dx')
            .whereRaw('dx.did = se.did_id')
            .where('dx.trusted', true)
            .where(qb =>
              qb
                .whereNull('dx.expires_at_time')
                .orWhere('dx.expires_at_time', '>=', new Date().toISOString()),
            )
        })
      }
    },
    snippet: r =>
      strip({
        id: r.id,
        type: r.type,
        lastObservedAtTime: iso(r.last_observed_at_time),
        serviceEndpoint: r.service_endpoint ?? undefined,
      }),
  },
}

function compileRequestSchema(): ValidateFunction {
  const schemaPath = new URL('../../../spec/graph/search.request.schema.json', import.meta.url)
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const ajv = new Ajv({ strict: false })
  addFormats.default(ajv as never)
  return ajv.compile(schema)
}

export function registerSearchRoute(app: FastifyInstance, db: Knex, config: Config): void {
  const validate = compileRequestSchema()

  app.post('/v4/graph/search', async (request, reply) => {
    const req = request.body as SearchRequest
    if (!validate(req)) {
      const detail = (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')
      throw new ApiError('INVALID_INPUT', `request does not match search schema: ${detail}`)
    }
    const def = SURFACES[req.surface]
    const freeText = req.freeText?.trim() || undefined
    const limit = req.limit ?? 20
    const hash = queryHash(req as unknown as Record<string, unknown>)

    const base = () => {
      const q = db(`${def.table} as ${def.alias}`)
      if (req.surface === 'Did') {
        q.leftJoin('corporations as corp', 'corp.id', 'd.corporation_id')
      }
      def.gates(q, req, config)
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
      if (freeText && def.hasVec) {
        q.whereRaw(`${def.alias}.search_vec @@ websearch_to_tsquery('simple', ?)`, [freeText])
      }
      return { q, facetSpecs }
    }

    // float8 end to end: NUMERIC scores round-trip through JS as lossy strings and break the
    // keyset boundary comparison
    const scoreSelect =
      freeText && def.hasVec
        ? `(ts_rank(${def.alias}.search_vec, websearch_to_tsquery('simple', ?)) * 10 + ${def.scoreExpr})::float8`
        : `(${def.scoreExpr})::float8`
    const scoreBindings = freeText && def.hasVec ? [freeText] : []

    const { q: hitsQuery, facetSpecs } = base()
    hitsQuery.select(`${def.alias}.*`).select(db.raw(`${scoreSelect} as _score`, scoreBindings))
    if (req.surface === 'Did') {
      hitsQuery.select(
        'corp.deposit as corp_deposit',
        'corp.slashed_events as corp_slashed_events',
        'corp.last_slashed_at_time as corp_last_slashed_at_time',
        'corp.slashed_value as corp_slashed_value',
      )
    }
    def.enrich?.(hitsQuery)
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

    const rows = (await hitsQuery) as Record<string, unknown>[]

    const { q: countQuery } = base()
    const countRow = (await countQuery.clearSelect().count('* as n').first()) as { n: string | number }
    const totalCount = Number(countRow.n)

    const facets: Record<string, { value: unknown; count: number }[]> = {}
    for (const [field, facetFn] of facetSpecs) {
      const { q: facetBase } = base()
      const rowsF = (await facetFn(facetBase, db)) as { value: unknown; count: string | number }[]
      facets[field] = rowsF.map(r => ({ value: r.value, count: Number(r.count) }))
    }

    const hits = rows.map(r => ({
      type: req.surface,
      id: (req.surface === 'Did' ? r.did : req.surface === 'ServiceEndpoint' ? r.id : Number(r.id)) as
        | string
        | number,
      score: Math.max(0, Number(r._score)),
      snippet: def.snippet(r),
    }))

    const last = rows[rows.length - 1]
    const cursor =
      rows.length === limit && last
        ? encodeCursor(Number(last._score), String(req.surface === 'Did' ? last.did : last.id), hash)
        : null

    return reply.send({ query: req, totalCount, hits, facets, cursor })
  })
}
