// field sets follow the vendored traverse response schema; every ref carries its pk,
// lastObservedAtTime, and its type's visibility flags (TG-QRY-3)

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function isoOrNull(v: Date | string | null): string | null {
  return v === null ? null : iso(v)
}

const strip = <T extends Record<string, unknown>>(obj: T): T => {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k]
  return obj
}

export interface DidRow {
  did: string
  trusted: boolean
  evaluated_at_time: Date
  evaluated_at_block: number
  expires_at_time: Date | null
  corporation_id: number | null
  pattern: 'A' | 'B' | null
  last_observed_at_time: Date
}

export function isTrustExpired(row: Pick<DidRow, 'expires_at_time'>): boolean {
  return row.expires_at_time !== null && row.expires_at_time.getTime() < Date.now()
}

export function didRef(row: DidRow) {
  return strip({
    did: row.did,
    lastObservedAtTime: iso(row.last_observed_at_time),
    isTrustExpired: isTrustExpired(row),
    trusted: row.trusted,
    pattern: row.pattern ?? undefined,
    corporationId: row.corporation_id ?? undefined,
  })
}

export function corporationRef(row: {
  id: number
  did: string
  policy_address: string | null
  deposit: string | null
  last_slashed_at_time: Date | null
  slashed_events: number
  slashed_value: string | null
  cgf: unknown
  last_observed_at_time: Date
}) {
  return strip({
    id: row.id,
    did: row.did,
    lastObservedAtTime: iso(row.last_observed_at_time),
    policyAddress: row.policy_address ?? undefined,
    deposit: row.deposit ?? undefined,
    lastSlashedAtTime: row.last_slashed_at_time ? iso(row.last_slashed_at_time) : undefined,
    slashedEvents: row.slashed_events,
    slashedValue: row.slashed_value ?? undefined,
    cgf: row.cgf ?? undefined,
  })
}

export function ecosystemRef(row: {
  id: number
  did: string
  corporation_id: number
  archived: boolean
  issued_credentials: number | null
  verified_credentials: number | null
  egf: unknown
  last_observed_at_time: Date
}) {
  return strip({
    id: row.id,
    did: row.did,
    corporationId: row.corporation_id,
    archived: row.archived,
    lastObservedAtTime: iso(row.last_observed_at_time),
    egf: row.egf ?? undefined,
    issuedCredentials: row.issued_credentials ?? undefined,
    verifiedCredentials: row.verified_credentials ?? undefined,
  })
}

export function schemaRef(row: {
  id: number
  type: string
  digest_sri: string
  archived: boolean
  ecosystem_id: number
  title: string | null
  description: string | null
  last_observed_at_time: Date
}) {
  return strip({
    id: row.id,
    type: row.type,
    digestSri: row.digest_sri,
    archived: row.archived,
    lastObservedAtTime: iso(row.last_observed_at_time),
    ecosystemId: row.ecosystem_id,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
  })
}

export interface ParticipantRow {
  id: number
  did_id: string
  role: string
  state: string
  credential_schema_id: number
  ecosystem_id: number
  vs_operator: string | null
  weight: string | null
  issued_credentials: number | null
  verified_credentials: number | null
  validator_participant_id: number | null
  last_observed_at_time: Date
}

export function participantRef(row: ParticipantRow) {
  return strip({
    id: row.id,
    didId: row.did_id,
    role: row.role,
    state: row.state,
    credentialSchemaId: row.credential_schema_id,
    ecosystemId: row.ecosystem_id,
    validatorParticipantId: row.validator_participant_id,
    lastObservedAtTime: iso(row.last_observed_at_time),
    vsOperator: row.vs_operator ?? undefined,
    weight: row.weight ?? undefined,
    issuedCredentials: row.issued_credentials ?? undefined,
    verifiedCredentials: row.verified_credentials ?? undefined,
  })
}

export interface EcsCredentialRow {
  id: string
  synthetic_id: boolean
  ecs_schema: string
  ecs_schema_version: string
  credential_schema_id: number
  issuer_participant_id: number
  ecosystem_id: number
  participant_id: number
  subject_did: string
  valid_from: Date
  valid_until: Date | null
  credential_subject: Record<string, unknown>
  digest_jcs: string | null
  issued_at_time: Date | null
  last_observed_at_time: Date
}

export function ecsCredentialRef(row: EcsCredentialRow) {
  return strip({
    // synthetic ids are internal keys, not upstream credential ids
    id: row.synthetic_id ? undefined : row.id,
    ecsSchema: row.ecs_schema,
    ecsSchemaVersion: row.ecs_schema_version,
    credentialSchemaId: row.credential_schema_id,
    issuerParticipantId: row.issuer_participant_id,
    ecosystemId: row.ecosystem_id,
    participantId: row.participant_id,
    subjectDid: row.subject_did,
    digestJCS: row.digest_jcs,
    issuedAtTime: isoOrNull(row.issued_at_time),
    validFrom: iso(row.valid_from),
    validUntil: isoOrNull(row.valid_until),
    credentialSubject: row.credential_subject,
    lastObservedAtTime: iso(row.last_observed_at_time),
  })
}

export interface VtcRow {
  id: string
  credential_schema_id: number
  ecosystem_id: number
  participant_id: number
  issuer_participant_id: number
  last_observed_at_time: Date
}

export function vtcRef(row: VtcRow) {
  return {
    id: row.id,
    credentialSchemaId: row.credential_schema_id,
    ecosystemId: row.ecosystem_id,
    participantId: row.participant_id,
    issuerParticipantId: row.issuer_participant_id,
    lastObservedAtTime: iso(row.last_observed_at_time),
  }
}

export function serviceEndpointRef(row: {
  id: string
  type: string
  service_endpoint: unknown
  accept: string[] | null
  last_observed_at_time: Date
}) {
  return strip({
    id: row.id,
    type: row.type,
    serviceEndpoint: row.service_endpoint,
    lastObservedAtTime: iso(row.last_observed_at_time),
    accept: row.accept ?? undefined,
  })
}
