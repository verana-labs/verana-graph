import { digestSriOf } from '../../src/deref/deref'
import { ResolveResponse } from '../../src/indexer/types'
import { MockWorld } from './mock-indexer'

// A compact world exercising every entity and edge:
//   corp 42 (did:mock:corp) controls ecosystem 7 (did:mock:eco) owning schemas 100 (service),
//   101 (org); did:mock:issuer issues; did:mock:vs is a Pattern-B VS holding a ServiceCredential
//   and presenting one non-ECS VTC; did:mock:plain is untrusted with no ServiceCredential.

export const DIDS = {
  corp: 'did:mock:corp',
  eco: 'did:mock:eco',
  issuer: 'did:mock:issuer',
  vs: 'did:mock:vs',
  plain: 'did:mock:plain',
  orphan: 'did:mock:orphan',
}

export const SCHEMA_BODIES: Record<number, string> = {
  100: JSON.stringify({
    $id: 'vpr:verana:mock:cs:100',
    title: 'Service Credential Schema',
    description: 'ECS service schema for verifiable services',
  }),
  101: JSON.stringify({
    $id: 'vpr:verana:mock:cs:101',
    title: 'Organization Credential Schema',
    description: 'ECS organization schema including plumber certification wording',
  }),
}

export const DIGESTS: Record<number, string> = {
  100: digestSriOf(SCHEMA_BODIES[100] as string, 'sha384'),
  101: digestSriOf(SCHEMA_BODIES[101] as string, 'sha384'),
}

const FAR_FUTURE = '2100-01-01T00:00:00Z'
const T0 = '2023-11-14T00:00:00Z'

function trustCore(
  did: string,
  trusted: boolean,
): Pick<
  ResolveResponse,
  'did' | 'trusted' | 'evaluatedAtTime' | 'evaluatedAtBlock' | 'expiresAtTime' | 'corporationId'
> {
  return {
    did,
    trusted,
    evaluatedAtTime: T0,
    evaluatedAtBlock: 99,
    expiresAtTime: FAR_FUTURE,
    corporationId: 42,
  }
}

export function ecosystemSection(archived101 = false) {
  return [
    {
      id: 7,
      corporationId: 42,
      archived: false,
      egf: {
        version: 1,
        activeSince: T0,
        documents: [{ language: 'en', url: 'https://mock.example/egf.md', digestSri: 'sha384-unfetched' }],
      },
      credentialSchemas: [
        { id: 100, type: 'JsonSchema', digestSri: DIGESTS[100] as string, archived: false },
        { id: 101, type: 'JsonSchema', digestSri: DIGESTS[101] as string, archived: archived101 },
      ],
      participants: { ISSUER: 1, HOLDER: 2 },
      issuedCredentials: 3,
      verifiedCredentials: 5,
    },
  ]
}

export function corpSnapshot(): ResolveResponse {
  return {
    ...trustCore(DIDS.corp, false),
    corporation: {
      id: 42,
      policyAddress: 'verana1mockpolicyaddress',
      deposit: '50000000uvna',
      slashedEvents: 0,
      cgf: {
        version: 1,
        activeSince: T0,
        documents: [{ language: 'en', url: 'https://mock.example/cgf.md', digestSri: 'sha384-unfetched2' }],
      },
    },
  }
}

export function ecoSnapshot(archived101 = false): ResolveResponse {
  return {
    ...trustCore(DIDS.eco, false),
    participations: [
      {
        id: 1,
        vsOperator: 'verana1ecooperator',
        role: 'ECOSYSTEM',
        state: 'ACTIVE',
        credentialSchemaId: 100,
        ecosystemId: 7,
        weight: '1000000uvna',
        validatorParticipantId: null,
      },
    ],
    ecosystems: ecosystemSection(archived101),
  }
}

export function issuerSnapshot(withOrgSchemaParticipant = true): ResolveResponse {
  const participations: NonNullable<ResolveResponse['participations']> = [
    {
      id: 10,
      vsOperator: 'verana1issueroperator',
      role: 'ISSUER',
      state: 'ACTIVE',
      credentialSchemaId: 100,
      ecosystemId: 7,
      weight: '2000000uvna',
      validatorParticipantId: 1,
      issuedCredentials: 2,
    },
    {
      id: 12,
      vsOperator: 'verana1issueroperator',
      role: 'HOLDER',
      state: 'ACTIVE',
      credentialSchemaId: 101,
      ecosystemId: 7,
      weight: '500000uvna',
      validatorParticipantId: 11,
    },
  ]
  if (withOrgSchemaParticipant) {
    participations.splice(1, 0, {
      id: 11,
      vsOperator: 'verana1issueroperator',
      role: 'ISSUER',
      state: 'ACTIVE',
      credentialSchemaId: 101,
      ecosystemId: 7,
      weight: '2000000uvna',
      validatorParticipantId: 1,
      issuedCredentials: 1,
    })
  }
  return {
    ...trustCore(DIDS.issuer, true),
    participations,
    ecsCredentials: [
      {
        id: 'urn:cred:org:issuer',
        ecsSchema: 'OrganizationCredential',
        ecsSchemaVersion: 'v4',
        digestJCS: 'ZGlnZXN0LTE=',
        issuedAtTime: T0,
        credentialSchemaId: 101,
        issuerParticipantId: 11,
        ecosystemId: 7,
        participantId: 12,
        validFrom: T0,
        validUntil: null,
        credentialSubject: {
          id: DIDS.issuer,
          name: 'Acme GmbH',
          address: 'Alexanderplatz 1, Berlin',
          countryCode: 'DE',
          registryId: 'HRB-12345',
        },
      },
    ],
    services: [
      {
        id: `${DIDS.issuer}#didcomm`,
        type: 'did-communication',
        serviceEndpoint: 'https://issuer.mock/didcomm',
      },
    ],
  }
}

export function vsSnapshot(withVp = true): ResolveResponse {
  return {
    ...trustCore(DIDS.vs, true),
    participations: [
      {
        id: 20,
        vsOperator: 'verana1vsoperator',
        role: 'HOLDER',
        state: 'ACTIVE',
        credentialSchemaId: 100,
        ecosystemId: 7,
        weight: '100000uvna',
        validatorParticipantId: 10,
      },
      {
        id: 21,
        vsOperator: 'verana1vsoperator',
        role: 'HOLDER',
        state: 'ACTIVE',
        credentialSchemaId: 101,
        ecosystemId: 7,
        weight: '100000uvna',
        validatorParticipantId: 11,
      },
    ],
    ecsCredentials: [
      {
        id: 'urn:cred:sc:vs',
        ecsSchema: 'ServiceCredential',
        ecsSchemaVersion: 'v4',
        digestJCS: 'ZGlnZXN0LTI=',
        issuedAtTime: T0,
        credentialSchemaId: 100,
        issuerParticipantId: 10,
        ecosystemId: 7,
        participantId: 20,
        validFrom: T0,
        validUntil: null,
        credentialSubject: {
          id: DIDS.vs,
          name: 'Baby Shoes Shop',
          type: 'ECommerce',
          description: 'We sell baby shoes in Bogota',
          minimumAgeRequired: 0,
        },
      },
    ],
    services: [
      { id: `${DIDS.vs}#didcomm`, type: 'did-communication', serviceEndpoint: 'https://vs.mock/didcomm' },
      { id: `${DIDS.vs}#mcp`, type: 'MCP', serviceEndpoint: 'https://vs.mock/mcp' },
    ],
    presentations: withVp
      ? [
          {
            id: 'https://vs.mock/vp1.json',
            serviceId: `${DIDS.vs}#vp1`,
            vtcCredentials: [
              {
                id: 'urn:vtc:cert:vs',
                credentialSchemaId: 101,
                ecosystemId: 7,
                participantId: 21,
                issuerParticipantId: 11,
              },
            ],
          },
        ]
      : [],
  }
}

export function plainSnapshot(): ResolveResponse {
  return { ...trustCore(DIDS.plain, false) }
}

// live finding L1: a DID no Corporation has adopted resolves with corporationId null
export function orphanSnapshot(): ResolveResponse {
  return { ...trustCore(DIDS.orphan, false), corporationId: null, expiresAtTime: null }
}

export function buildWorld(): MockWorld {
  const snapshots = new Map<string, Map<number, ResolveResponse>>()
  const put = (did: string, from: number, snap: ResolveResponse) => {
    const versions = snapshots.get(did) ?? new Map<number, ResolveResponse>()
    versions.set(from, snap)
    snapshots.set(did, versions)
  }
  put(DIDS.corp, 0, corpSnapshot())
  put(DIDS.eco, 0, ecoSnapshot())
  put(DIDS.issuer, 0, issuerSnapshot())
  put(DIDS.vs, 0, vsSnapshot())
  put(DIDS.plain, 0, plainSnapshot())
  put(DIDS.orphan, 0, orphanSnapshot())

  return {
    snapshots,
    schemaBodies: new Map(Object.entries(SCHEMA_BODIES).map(([k, v]) => [Number(k), v])),
    blocks: [],
    readyBlock: 100,
    blockIntervalMs: 200,
  }
}
