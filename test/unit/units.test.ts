import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import { decodeCursor, encodeCursor, queryHash } from '../../src/api/search/cursor'
import { normalizeFilterValue, resolveFieldSpec } from '../../src/api/search/registry'
import { digestSriOf } from '../../src/deref/deref'
import { canonicalResolveBody } from '../../src/indexer/rest'
import { CANONICAL_SUBSCRIBE } from '../../src/indexer/ws'
import { extractSubjectText, identityFromCredentials } from '../../src/ingest/denorm'
import { ecsCredentialId } from '../../src/ingest/reconciler'

describe('cursor', () => {
  it('round-trips and binds to its query', () => {
    const hash = queryHash({ surface: 'Did', freeText: 'x' })
    const c = encodeCursor(1.5, 'did:a', hash)
    expect(decodeCursor(c, hash)).toMatchObject({ s: 1.5, k: 'did:a' })
    expect(() => decodeCursor(c, queryHash({ surface: 'Ecosystem' }))).toThrowError(ApiError)
    expect(() => decodeCursor('garbage!', hash)).toThrowError(ApiError)
  })

  it('hash ignores limit and cursor but not filters', () => {
    const a = queryHash({ surface: 'Did', filters: { x: 1 }, limit: 10, cursor: 'c' })
    const b = queryHash({ surface: 'Did', filters: { x: 1 }, limit: 50 })
    const c = queryHash({ surface: 'Did', filters: { x: 2 } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('filter normalization (TG-FCT-3 value forms)', () => {
  it('bare scalar means eq, bare array means in', () => {
    expect(normalizeFilterValue('f', 'x')).toEqual({ op: 'eq', value: 'x' })
    expect(normalizeFilterValue('f', ['a', 'b'])).toEqual({ op: 'in', value: ['a', 'b'] })
    expect(normalizeFilterValue('f', { prefix: 'CO-' })).toEqual({ op: 'prefix', value: 'CO-' })
    expect(() => normalizeFilterValue('f', { nope: 1 })).toThrowError(ApiError)
  })

  it('per-surface field registry rejects unknown fields and wrong operators', () => {
    expect(() => resolveFieldSpec('Did', 'Did.nonsense')).toThrowError(ApiError)
    expect(() => resolveFieldSpec('Did', '__proto__')).toThrowError(ApiError)
    expect(() => resolveFieldSpec('Did', 'constructor')).toThrowError(ApiError)
    const spec = resolveFieldSpec('Did', 'OrganizationCredential.lei')
    expect(spec.ops).toEqual(['eq'])
    expect(resolveFieldSpec('Ecosystem', 'participants[ISSUER]').ops).toEqual(['range'])
    expect(() => resolveFieldSpec('Ecosystem', 'participants[NOPE]')).toThrowError(ApiError)
  })
})

describe('canonical upstream payloads', () => {
  it('TG-INGEST-2: resolve body matches the spec verbatim', () => {
    expect(canonicalResolveBody('did:x')).toEqual({
      did: 'did:x',
      corporation: true,
      participations: { states: ['ACTIVE'] },
      ecsCredentials: true,
      services: true,
      presentations: true,
      ecosystems: { includeArchived: true, credentialSchemas: { includeArchived: true } },
    })
  })

  it('TG-INGEST-1: subscribe message has every channel and sub-flag on, no dids field', () => {
    expect(CANONICAL_SUBSCRIBE).not.toHaveProperty('dids')
    expect(CANONICAL_SUBSCRIBE.channels.trust).toBe(true)
    expect(CANONICAL_SUBSCRIBE.channels.participations).toEqual({
      includeWeightChanges: true,
      includeParticipantCounts: true,
      includeIssuedCredentials: true,
      includeVerifiedCredentials: true,
    })
  })
})

describe('denormalisation helpers', () => {
  it('identity prefers Organization over Persona', () => {
    const id = identityFromCredentials([
      {
        ecsSchema: 'PersonaCredential',
        credentialSubject: { id: 'did:p', name: '@fabrice', controllerCountryCode: 'FR' },
      },
      {
        ecsSchema: 'OrganizationCredential',
        credentialSubject: { id: 'did:o', name: 'Acme', countryCode: 'DE' },
      },
    ])
    expect(id.operatorKind).toBe('Organization')
    expect(id.orgCountryCode).toBe('DE')
  })

  it('extractSubjectText walks nested claims and skips the subject id', () => {
    expect(extractSubjectText({ id: 'did:x', categories: ['baby-shoes', { label: 'kids' }], size: 4 })).toBe(
      'baby-shoes kids',
    )
  })

  it('synthetic EcsCredential ids are deterministic on the holder participant', () => {
    const entry = { participantId: 77 } as never
    expect(ecsCredentialId(entry)).toEqual({ id: 'urn:verana-graph:ecs:77', synthetic: true })
  })
})

describe('digestSri', () => {
  it('produces the SRI form the spec expects', () => {
    const d = digestSriOf('{"a":1}', 'sha384')
    expect(d).toMatch(/^sha384-[A-Za-z0-9+/=]+$/)
    expect(digestSriOf('{"a":1}', 'sha384')).toBe(d)
    expect(digestSriOf('{"a":2}', 'sha384')).not.toBe(d)
  })
})
