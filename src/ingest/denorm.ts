import { Knex } from 'knex'
import { EcsCredentialEntry, ResolveResponse } from '../indexer/types'

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export interface OperativeIdentity {
  operatorKind: 'Organization' | 'Persona' | null
  orgName: string | null
  orgAddress: string | null
  orgCountryCode: string | null
  orgLegalJurisdiction: string | null
  orgOrganizationKind: string | null
  orgLei: string | null
  orgRegistryId: string | null
  orgLogoUri: string | null
  orgLogoDigestSri: string | null
  personaName: string | null
  personaDescription: string | null
  personaCountryCode: string | null
  personaJurisdiction: string | null
  personaAvatarUri: string | null
  personaAvatarDigestSri: string | null
}

export const EMPTY_IDENTITY: OperativeIdentity = {
  operatorKind: null,
  orgName: null,
  orgAddress: null,
  orgCountryCode: null,
  orgLegalJurisdiction: null,
  orgOrganizationKind: null,
  orgLei: null,
  orgRegistryId: null,
  orgLogoUri: null,
  orgLogoDigestSri: null,
  personaName: null,
  personaDescription: null,
  personaCountryCode: null,
  personaJurisdiction: null,
  personaAvatarUri: null,
  personaAvatarDigestSri: null,
}

// TG-FCT-3: the operative ORG-or-PERSONA credential the trust chain rests on
// (Pattern A: the DID's own; Pattern B: the ServiceCredential issuer's)
export function identityFromCredentials(
  creds: Pick<EcsCredentialEntry, 'ecsSchema' | 'credentialSubject'>[],
): OperativeIdentity {
  const out = { ...EMPTY_IDENTITY }
  const org = creds.find(c => c.ecsSchema === 'OrganizationCredential')
  const persona = creds.find(c => c.ecsSchema === 'PersonaCredential')
  if (org) {
    const s = org.credentialSubject
    out.operatorKind = 'Organization'
    out.orgName = str(s.name)
    out.orgAddress = str(s.address)
    out.orgCountryCode = str(s.countryCode)
    out.orgLegalJurisdiction = str(s.legalJurisdiction)
    out.orgOrganizationKind = str(s.organizationKind)
    out.orgLei = str(s.lei)
    out.orgRegistryId = str(s.registryId)
    out.orgLogoUri = str(s.logoUri)
    out.orgLogoDigestSri = str(s.logoDigestSri)
  } else if (persona) {
    const s = persona.credentialSubject
    out.operatorKind = 'Persona'
    out.personaName = str(s.name)
    out.personaDescription = str(s.description)
    out.personaCountryCode = str(s.controllerCountryCode)
    out.personaJurisdiction = str(s.controllerJurisdiction)
    out.personaAvatarUri = str(s.avatarUri)
    out.personaAvatarDigestSri = str(s.avatarDigestSri)
  }
  return out
}

export interface ServiceFacets {
  scName: string | null
  scType: string | null
  scDescription: string | null
  scLogoUri: string | null
  scLogoDigestSri: string | null
  minAge: number | null
}

export function serviceFacets(response: ResolveResponse): ServiceFacets {
  const sc = (response.ecsCredentials ?? []).find(c => c.ecsSchema === 'ServiceCredential')
  if (!sc)
    return {
      scName: null,
      scType: null,
      scDescription: null,
      scLogoUri: null,
      scLogoDigestSri: null,
      minAge: null,
    }
  const s = sc.credentialSubject
  const age = typeof s.minimumAgeRequired === 'number' ? s.minimumAgeRequired : null
  return {
    scName: str(s.name),
    scType: str(s.type),
    scDescription: str(s.description),
    scLogoUri: str(s.logoUri),
    scLogoDigestSri: str(s.logoDigestSri),
    minAge: age,
  }
}

// TG-FCT-4: schema-text slot, title/description of every schema the DID participates in
export async function schemaTextForDid(trx: Knex, did: string): Promise<string | null> {
  const rows = await trx('credential_schemas as cs')
    .join('participants as p', 'p.credential_schema_id', 'cs.id')
    .where('p.did_id', did)
    .where('p.state', 'ACTIVE')
    .distinct<{ title: string | null; description: string | null }[]>('cs.id', 'cs.title', 'cs.description')
  const text = rows
    .flatMap(r => [r.title, r.description])
    .filter((s): s is string => Boolean(s))
    .join(' ')
  return text.length ? text : null
}

// TG-FCT-4: VTC subject-claim denormalisation slot (populated only when VP bodies are fetched)
export async function vtcTextForDid(trx: Knex, did: string): Promise<string | null> {
  const rows = await trx('vtcs as v')
    .join('lvp_vtcs as lv', 'lv.vtc_id', 'v.id')
    .join('linked_vps as l', 'l.id', 'lv.lvp_id')
    .where('l.did_id', did)
    .whereNotNull('v.subject_text')
    .distinct<{ subject_text: string }[]>('v.id', 'v.subject_text')
  const text = rows.map(r => r.subject_text).join(' ')
  return text.length ? text : null
}

export function extractSubjectText(credentialSubject: Record<string, unknown>): string | null {
  const parts: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const [k, v] of Object.entries(credentialSubject)) {
    if (k === 'id') continue
    walk(v)
  }
  const text = parts.join(' ').trim()
  return text.length ? text : null
}
