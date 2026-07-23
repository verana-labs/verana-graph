// Shapes of the indexer's Verifiable Trust contract, per spec/indexer/*.schema.json

export interface GovernanceFrameworkDoc {
  language: string
  url: string
  digestSri: string
}

export interface GovernanceFramework {
  version: number
  activeSince?: string
  documents: GovernanceFrameworkDoc[]
}

export interface CorporationSection {
  id: number
  policyAddress?: string
  deposit?: string
  lastSlashedAtTime?: string | null
  slashedEvents?: number
  slashedValue?: string | null
  cgf?: GovernanceFramework | null
}

export type ParticipantRole =
  | 'HOLDER'
  | 'ISSUER'
  | 'VERIFIER'
  | 'ISSUER_GRANTOR'
  | 'VERIFIER_GRANTOR'
  | 'ECOSYSTEM'

export interface ParticipationEntry {
  id: number
  vsOperator: string
  role: ParticipantRole
  state: string
  credentialSchemaId: number
  ecosystemId: number
  weight: string
  validatorParticipantId: number | null
  issuedCredentials?: number
  verifiedCredentials?: number
  participants?: Record<string, number>
}

export type EcsSchemaName =
  | 'ServiceCredential'
  | 'OrganizationCredential'
  | 'PersonaCredential'
  | 'UserAgentCredential'

export interface EcsCredentialEntry {
  id?: string
  ecsSchema: EcsSchemaName
  ecsSchemaVersion: string
  credentialSchemaId: number
  issuerParticipantId: number
  ecosystemId: number
  participantId: number
  validFrom: string
  validUntil: string | null
  credentialSubject: Record<string, unknown> & { id: string }
}

export interface VtcCredentialRef {
  id: string
  credentialSchemaId: number
  ecosystemId: number
  participantId: number
  issuerParticipantId: number
}

export interface PresentationEntry {
  id: string
  serviceId: string
  vtcCredentials: VtcCredentialRef[]
}

export interface ServiceEntry {
  id: string
  type: string
  serviceEndpoint: string | Record<string, unknown>
  accept?: string[]
}

export interface EcosystemSchemaSummary {
  id: number
  type: string
  digestSri: string
  archived: boolean
  participants?: Record<string, number>
  issuedCredentials?: number
  verifiedCredentials?: number
}

export interface EcosystemEntry {
  id: number
  corporationId: number
  archived: boolean
  egf?: GovernanceFramework | null
  credentialSchemas?: EcosystemSchemaSummary[]
  participants?: Record<string, number>
  issuedCredentials?: number
  verifiedCredentials?: number
}

export interface ResolveResponse {
  did: string
  trusted: boolean
  evaluatedAtTime: string
  evaluatedAtBlock: number
  expiresAtTime: string | null
  corporationId: number | null
  corporation?: CorporationSection
  participations?: ParticipationEntry[]
  ecsCredentials?: EcsCredentialEntry[]
  presentations?: PresentationEntry[]
  services?: ServiceEntry[]
  ecosystems?: EcosystemEntry[]
}

export interface TrustChange {
  trusted: boolean
  evaluatedAtTime: string
  evaluatedAtBlock: number
  expiresAtTime: string | null
  corporationId: number | null
}

export interface ChangeEnvelope {
  did: string
  trust?: boolean | TrustChange
  corporation?: boolean
  participations?: boolean
  ecsCredentials?: boolean
  presentations?: boolean
  services?: boolean
  ecosystems?: boolean
}

export interface ReadyMessage {
  type: 'ready'
  block: number
  blockTime: string
  blockIntervalMs: number
}

export interface BlockMessage {
  type: 'block'
  block: number
  blockTime: string
  changes: ChangeEnvelope[]
}

export interface ListDidsResponse {
  atBlock: number
  dids: string[]
  nextCursor?: string | null
}

export interface ChangesBlock {
  block: number
  blockTime: string
  changes: ChangeEnvelope[]
}

export interface ListChangesResponse {
  currentBlock: number
  fromBlock: number
  blocks: ChangesBlock[]
  nextFromBlock: number | null
}

// true when any non-trust channel flagged a change: exactly one resolve is due
export function needsResolve(e: ChangeEnvelope): boolean {
  return Boolean(
    e.corporation || e.participations || e.ecsCredentials || e.presentations || e.services || e.ecosystems,
  )
}
