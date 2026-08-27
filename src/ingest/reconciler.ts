import { Knex } from 'knex'
import { EcsCredentialEntry, ResolveResponse, TrustChange } from '../indexer/types'
import {
  EMPTY_IDENTITY,
  identityFromCredentials,
  OperativeIdentity,
  schemaTextForDid,
  serviceFacets,
  vtcTextForDid,
} from './denorm'

export interface Evidence {
  block: number
  blockTime: string
}

export interface SchemaLoadRequest {
  schemaId: number
  digestSri: string
  type: string
  archived: boolean
  ecosystemId: number
  evidence: Evidence
}

function coinAmount(coin: string | null | undefined): string | null {
  const m = coin?.match(/^([0-9]+)[a-z][a-z0-9]*$/)
  return m ? (m[1] as string) : null
}

function freshness(e: Evidence) {
  return { last_observed_at_time: e.blockTime, last_observed_at_block: e.block }
}

// deterministic fallback when upstream omits the credential id
export function ecsCredentialId(entry: EcsCredentialEntry): { id: string; synthetic: boolean } {
  if (entry.id) return { id: entry.id, synthetic: false }
  return { id: `urn:verana-graph:ecs:${entry.participantId}`, synthetic: true }
}

// TG-INGEST-4 step 1: the trust channel is inline; no resolve needed
export async function applyInlineTrust(
  db: Knex,
  did: string,
  t: TrustChange,
  evidence: Evidence,
): Promise<void> {
  const core = {
    trusted: t.trusted,
    evaluated_at_time: t.evaluatedAtTime,
    evaluated_at_block: t.evaluatedAtBlock,
    expires_at_time: t.expiresAtTime,
    corporation_id: t.corporationId,
    ...freshness(evidence),
  }
  const updated = await db('dids').where({ did }).update(core)
  if (updated === 0) await db('dids').insert({ did, ...core })
}

// TG-PROV-1: overwrite what changed, stamp freshness, hard-delete per-DID-owned records absent
// from the response. Runs inside the caller's transaction: the orchestrator owns the
// one-block-one-commit boundary (TG-INGEST-4). Returns schema ids that still need a body load
// (handed to the dereferencer after commit, TG-DEREF-2).
export async function reconcile(
  trx: Knex,
  response: ResolveResponse,
  evidence: Evidence,
): Promise<SchemaLoadRequest[]> {
  const schemaLoads: SchemaLoadRequest[] = []
  const did = response.did

  await upsertParticipants(trx, response, evidence)
  await upsertCorporation(trx, response, evidence)
  schemaLoads.push(...(await upsertEcosystems(trx, response, evidence)))
  await upsertServiceEndpoints(trx, response, evidence)
  await upsertPresentations(trx, response, evidence)
  await upsertEcsCredentials(trx, response, evidence)
  await upsertDid(trx, response, evidence)
  await refreshDependentDids(trx, did, evidence)
  return schemaLoads
}

export async function sweepUnreferencedParticipants(trx: Knex): Promise<void> {
  for (;;) {
    const deleted = await trx('participants as p')
      .whereNot('p.state', 'ACTIVE')
      .whereNotExists(function () {
        this.select(1).from('ecs_credentials as ec').whereRaw('ec.issuer_participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('ecs_credentials as ec').whereRaw('ec.participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('vtcs as v').whereRaw('v.issuer_participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('vtcs as v').whereRaw('v.participant_id = p.id')
      })
      .whereNotExists(function () {
        this.select(1).from('participants as child').whereRaw('child.validator_participant_id = p.id')
      })
      .delete()
    if (deleted === 0) return
  }
}

async function upsertParticipants(trx: Knex, r: ResolveResponse, e: Evidence): Promise<void> {
  const entries = r.participations ?? []
  const ids = entries.map(p => p.id)
  // diff-from-absence: anything of this DID not in the fresh response left ACTIVE (TG-ACT-1)
  await trx('participants').where('did_id', r.did).whereNotIn('id', ids).delete()
  for (const p of entries) {
    const row = {
      id: p.id,
      did_id: r.did,
      corporation_id: r.corporationId,
      vs_operator: p.vsOperator ?? null,
      credential_schema_id: p.credentialSchemaId,
      ecosystem_id: p.ecosystemId,
      role: p.role,
      state: p.state,
      weight: p.weight ?? null,
      weight_amount: coinAmount(p.weight),
      issued_credentials: p.issuedCredentials ?? null,
      verified_credentials: p.verifiedCredentials ?? null,
      participants_by_child_role: p.participants ? JSON.stringify(p.participants) : null,
      validator_participant_id: p.validatorParticipantId,
      ...freshness(e),
    }
    await trx('participants').insert(row).onConflict('id').merge()
  }
}

async function upsertCorporation(trx: Knex, r: ResolveResponse, e: Evidence): Promise<void> {
  const c = r.corporation
  if (!c) return
  await trx('corporations')
    .insert({
      id: c.id,
      policy_address: c.policyAddress ?? null,
      did: r.did,
      deposit: c.deposit ?? null,
      deposit_amount: coinAmount(c.deposit),
      last_slashed_at_time: c.lastSlashedAtTime ?? null,
      slashed_events: c.slashedEvents ?? 0,
      slashed_value: c.slashedValue ?? null,
      cgf: c.cgf ? JSON.stringify(c.cgf) : null,
      ...freshness(e),
    })
    .onConflict('id')
    .merge()
}

async function upsertEcosystems(trx: Knex, r: ResolveResponse, e: Evidence): Promise<SchemaLoadRequest[]> {
  const loads: SchemaLoadRequest[] = []
  for (const eco of r.ecosystems ?? []) {
    const schemas = eco.credentialSchemas ?? []
    await trx('ecosystems')
      .insert({
        id: eco.id,
        did: r.did,
        archived: eco.archived,
        corporation_id: eco.corporationId,
        participants: eco.participants ? JSON.stringify(eco.participants) : null,
        issued_credentials: eco.issuedCredentials ?? null,
        verified_credentials: eco.verifiedCredentials ?? null,
        credential_schema_ids: schemas.map(s => s.id),
        egf: eco.egf ? JSON.stringify(eco.egf) : null,
        ...freshness(e),
      })
      .onConflict('id')
      .merge()

    for (const s of schemas) {
      // TG-DEREF-2 step 2: known schema, body immutable; only archived + freshness move
      const updated = await trx('credential_schemas')
        .where({ id: s.id })
        .update({
          archived: s.archived,
          participants: s.participants ? JSON.stringify(s.participants) : null,
          issued_credentials: s.issuedCredentials ?? null,
          verified_credentials: s.verifiedCredentials ?? null,
          ...freshness(e),
        })
      if (updated === 0) {
        loads.push({
          schemaId: s.id,
          digestSri: s.digestSri,
          type: s.type,
          archived: s.archived,
          ecosystemId: eco.id,
          evidence: e,
        })
      }
    }
  }
  return loads
}

async function upsertServiceEndpoints(trx: Knex, r: ResolveResponse, e: Evidence): Promise<void> {
  const entries = r.services ?? []
  await trx('service_endpoints')
    .where('did_id', r.did)
    .whereNotIn(
      'id',
      entries.map(s => s.id),
    )
    .delete()
  for (const s of entries) {
    await trx('service_endpoints')
      .insert({
        id: s.id,
        did_id: r.did,
        type: s.type,
        service_endpoint: JSON.stringify(s.serviceEndpoint),
        accept: s.accept ?? null,
        ...freshness(e),
      })
      .onConflict('id')
      .merge()
  }
}

async function upsertPresentations(trx: Knex, r: ResolveResponse, e: Evidence): Promise<void> {
  const entries = r.presentations ?? []
  const vpIds = entries.map(p => p.id)
  // join rows must go before their VPs or the orphan-Vtc refcount never reaches zero
  const stale = await trx('linked_vps')
    .where('did_id', r.did)
    .whereNotIn('id', vpIds)
    .select<{ id: string }[]>('id')
  if (stale.length > 0) {
    const staleIds = stale.map(s => s.id)
    await trx('lvp_vtcs').whereIn('lvp_id', staleIds).delete()
    await trx('linked_vps').whereIn('id', staleIds).delete()
  }
  for (const p of entries) {
    await trx('linked_vps')
      .insert({ id: p.id, service_id: p.serviceId, did_id: r.did, ...freshness(e) })
      .onConflict('id')
      .merge()
    const vtcIds = p.vtcCredentials.map(v => v.id)
    await trx('lvp_vtcs').where('lvp_id', p.id).whereNotIn('vtc_id', vtcIds).delete()
    for (const v of p.vtcCredentials) {
      await trx('vtcs')
        .insert({
          id: v.id,
          credential_schema_id: v.credentialSchemaId,
          ecosystem_id: v.ecosystemId,
          participant_id: v.participantId,
          issuer_participant_id: v.issuerParticipantId,
          ...freshness(e),
        })
        .onConflict('id')
        .merge([
          'credential_schema_id',
          'ecosystem_id',
          'participant_id',
          'issuer_participant_id',
          'last_observed_at_time',
          'last_observed_at_block',
        ])
      await trx('lvp_vtcs')
        .insert({ lvp_id: p.id, vtc_id: v.id, ...freshness(e) })
        .onConflict(['lvp_id', 'vtc_id'])
        .merge()
    }
  }
  // TG-ACT-1: a Vtc with no inbound CONTAINS_VTC edge is an orphan
  await trx('vtcs').whereNotIn('id', trx('lvp_vtcs').select('vtc_id')).delete()
}

async function upsertEcsCredentials(trx: Knex, r: ResolveResponse, e: Evidence): Promise<void> {
  const entries = (r.ecsCredentials ?? []).filter(c => c.ecsSchema !== 'UserAgentCredential')
  const ids = entries.map(c => ecsCredentialId(c).id)
  await trx('ecs_credentials').where('subject_did', r.did).whereNotIn('id', ids).delete()
  // record-level expiry observed on this DID's own records (TG-ACT-1)
  await trx('ecs_credentials')
    .where('subject_did', r.did)
    .whereNotNull('valid_until')
    .where('valid_until', '<', trx.fn.now())
    .delete()
  for (const c of entries) {
    const { id, synthetic } = ecsCredentialId(c)
    if (c.validUntil && new Date(c.validUntil).getTime() < Date.now()) continue
    await trx('ecs_credentials')
      .insert({
        id,
        synthetic_id: synthetic,
        ecs_schema: c.ecsSchema,
        ecs_schema_version: c.ecsSchemaVersion,
        credential_schema_id: c.credentialSchemaId,
        issuer_participant_id: c.issuerParticipantId,
        ecosystem_id: c.ecosystemId,
        participant_id: c.participantId,
        subject_did: c.credentialSubject.id,
        digest_jcs: c.digestJCS ?? null,
        issued_at_time: c.issuedAtTime ?? null,
        valid_from: c.validFrom,
        valid_until: c.validUntil,
        credential_subject: JSON.stringify(c.credentialSubject),
        ...freshness(e),
      })
      .onConflict('id')
      .merge()
  }
}

interface PatternResult {
  pattern: 'A' | 'B' | null
  issuerDid: string | null
}

// pattern A when the ServiceCredential's issuer Participant belongs to
// the subject DID itself, B when it belongs to another DID, null when there is no
// ServiceCredential (untrusted DID) or the issuer Participant is not materialised yet
async function derivePattern(trx: Knex, r: ResolveResponse): Promise<PatternResult> {
  const sc = (r.ecsCredentials ?? []).find(c => c.ecsSchema === 'ServiceCredential')
  if (!sc || !sc.issuerParticipantId) return { pattern: null, issuerDid: null }
  const issuer = await trx('participants')
    .where('id', sc.issuerParticipantId)
    .first<{ did_id: string } | undefined>('did_id')
  if (!issuer) return { pattern: 'B', issuerDid: null }
  return issuer.did_id === r.did
    ? { pattern: 'A', issuerDid: r.did }
    : { pattern: 'B', issuerDid: issuer.did_id }
}

async function operativeIdentity(
  trx: Knex,
  r: ResolveResponse,
  p: PatternResult,
): Promise<OperativeIdentity> {
  if (p.pattern === 'A' || p.pattern === null) {
    return identityFromCredentials(r.ecsCredentials ?? [])
  }
  if (!p.issuerDid) return EMPTY_IDENTITY
  const issuerCreds = await trx('ecs_credentials')
    .where('subject_did', p.issuerDid)
    .whereIn('ecs_schema', ['OrganizationCredential', 'PersonaCredential'])
    .select<{ ecs_schema: string; credential_subject: Record<string, unknown> }[]>(
      'ecs_schema',
      'credential_subject',
    )
  return identityFromCredentials(
    issuerCreds.map(c => ({
      ecsSchema: c.ecs_schema as EcsCredentialEntry['ecsSchema'],
      credentialSubject: c.credential_subject as EcsCredentialEntry['credentialSubject'],
    })),
  )
}

async function upsertDid(trx: Knex, r: ResolveResponse, e: Evidence): Promise<void> {
  const p = await derivePattern(trx, r)
  const identity = await operativeIdentity(trx, r, p)
  const facets = serviceFacets(r)
  const row = {
    did: r.did,
    trusted: r.trusted,
    evaluated_at_time: r.evaluatedAtTime,
    evaluated_at_block: r.evaluatedAtBlock,
    expires_at_time: r.expiresAtTime,
    corporation_id: r.corporationId,
    pattern: p.pattern,
    service_types: (r.services ?? []).map(s => s.type),
    operator_kind: identity.operatorKind,
    sc_name: facets.scName,
    sc_type: facets.scType,
    sc_description: facets.scDescription,
    sc_logo_uri: facets.scLogoUri,
    sc_logo_digest_sri: facets.scLogoDigestSri,
    min_age: facets.minAge,
    org_name: identity.orgName,
    org_address: identity.orgAddress,
    org_country_code: identity.orgCountryCode,
    org_legal_jurisdiction: identity.orgLegalJurisdiction,
    org_organization_kind: identity.orgOrganizationKind,
    org_lei: identity.orgLei,
    org_registry_id: identity.orgRegistryId,
    org_logo_uri: identity.orgLogoUri,
    org_logo_digest_sri: identity.orgLogoDigestSri,
    persona_name: identity.personaName,
    persona_description: identity.personaDescription,
    persona_country_code: identity.personaCountryCode,
    persona_jurisdiction: identity.personaJurisdiction,
    persona_avatar_uri: identity.personaAvatarUri,
    persona_avatar_digest_sri: identity.personaAvatarDigestSri,
    schema_text: await schemaTextForDid(trx, r.did),
    vtc_text: await vtcTextForDid(trx, r.did),
    ...freshness(e),
  }
  await trx('dids').insert(row).onConflict('did').merge()
}

// Bootstrap resolves DIDs concurrently, so cross-DID derivations (pattern, operative identity,
// schema text) can see uncommitted state. This pass re-derives them from committed rows once
// the snapshot is complete. Live blocks are serial and do not need it.
export async function repairDerivedFacets(db: Knex): Promise<void> {
  const serviceCreds = await db('ecs_credentials')
    .where('ecs_schema', 'ServiceCredential')
    .select<{ subject_did: string; issuer_participant_id: number }[]>('subject_did', 'issuer_participant_id')

  for (const sc of serviceCreds) {
    await db.transaction(async trx => {
      const issuer = await trx('participants')
        .where('id', sc.issuer_participant_id)
        .first<{ did_id: string } | undefined>('did_id')
      const pattern = issuer && issuer.did_id === sc.subject_did ? 'A' : 'B'
      const sourceDid = pattern === 'A' ? sc.subject_did : issuer?.did_id
      let identity = EMPTY_IDENTITY
      if (sourceDid) {
        const creds = await trx('ecs_credentials')
          .where('subject_did', sourceDid)
          .whereIn('ecs_schema', ['OrganizationCredential', 'PersonaCredential'])
          .select<{ ecs_schema: string; credential_subject: Record<string, unknown> }[]>(
            'ecs_schema',
            'credential_subject',
          )
        identity = identityFromCredentials(
          creds.map(c => ({
            ecsSchema: c.ecs_schema as EcsCredentialEntry['ecsSchema'],
            credentialSubject: c.credential_subject as EcsCredentialEntry['credentialSubject'],
          })),
        )
      }
      await trx('dids').where('did', sc.subject_did).update({
        pattern,
        operator_kind: identity.operatorKind,
        org_name: identity.orgName,
        org_address: identity.orgAddress,
        org_country_code: identity.orgCountryCode,
        org_legal_jurisdiction: identity.orgLegalJurisdiction,
        org_organization_kind: identity.orgOrganizationKind,
        org_lei: identity.orgLei,
        org_registry_id: identity.orgRegistryId,
        org_logo_uri: identity.orgLogoUri,
        org_logo_digest_sri: identity.orgLogoDigestSri,
        persona_name: identity.personaName,
        persona_description: identity.personaDescription,
        persona_country_code: identity.personaCountryCode,
        persona_jurisdiction: identity.personaJurisdiction,
        persona_avatar_uri: identity.personaAvatarUri,
        persona_avatar_digest_sri: identity.personaAvatarDigestSri,
      })
    })
  }

  await db.raw(`
    UPDATE dids SET schema_text = sub.text FROM (
      SELECT p.did_id, string_agg(DISTINCT concat_ws(' ', cs.title, cs.description), ' ') AS text
      FROM participants p JOIN credential_schemas cs ON cs.id = p.credential_schema_id
      WHERE p.state = 'ACTIVE'
      GROUP BY p.did_id
    ) sub WHERE dids.did = sub.did_id
  `)
}

// Pattern-B DIDs inherit operative identity from their ServiceCredential issuer. When the
// issuer DID's own Org/Persona credentials change, dependents must be refreshed.
async function refreshDependentDids(trx: Knex, issuerDid: string, e: Evidence): Promise<void> {
  const dependents = await trx('ecs_credentials as sc')
    .join('participants as ip', 'ip.id', 'sc.issuer_participant_id')
    .where('ip.did_id', issuerDid)
    .where('sc.ecs_schema', 'ServiceCredential')
    .whereNot('sc.subject_did', issuerDid)
    .distinct<{ subject_did: string }[]>('sc.subject_did')

  const issuerCreds = await trx('ecs_credentials')
    .where('subject_did', issuerDid)
    .whereIn('ecs_schema', ['OrganizationCredential', 'PersonaCredential'])
    .select<{ ecs_schema: string; credential_subject: Record<string, unknown> }[]>(
      'ecs_schema',
      'credential_subject',
    )
  const identity = identityFromCredentials(
    issuerCreds.map(c => ({
      ecsSchema: c.ecs_schema as EcsCredentialEntry['ecsSchema'],
      credentialSubject: c.credential_subject as EcsCredentialEntry['credentialSubject'],
    })),
  )

  for (const d of dependents) {
    await trx('dids')
      .where({ did: d.subject_did, pattern: 'B' })
      .update({
        operator_kind: identity.operatorKind,
        org_name: identity.orgName,
        org_address: identity.orgAddress,
        org_country_code: identity.orgCountryCode,
        org_legal_jurisdiction: identity.orgLegalJurisdiction,
        org_organization_kind: identity.orgOrganizationKind,
        org_lei: identity.orgLei,
        org_registry_id: identity.orgRegistryId,
        org_logo_uri: identity.orgLogoUri,
        org_logo_digest_sri: identity.orgLogoDigestSri,
        persona_name: identity.personaName,
        persona_description: identity.personaDescription,
        persona_country_code: identity.personaCountryCode,
        persona_jurisdiction: identity.personaJurisdiction,
        persona_avatar_uri: identity.personaAvatarUri,
        persona_avatar_digest_sri: identity.personaAvatarDigestSri,
        ...freshness(e),
      })
  }
}
