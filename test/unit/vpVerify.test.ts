import { describe, expect, it } from 'vitest'
import { type DidDocumentLike, verifyVpSignature } from '../../src/deref/vpVerify'
import { makeHolder, signVp } from '../harness/vp'

const HOLDER = 'did:webvh:test:holder.example'

const DEVNET_HOLDER =
  'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network'
const DEVNET_KEY = `${DEVNET_HOLDER}#z6MkovYXbVumDMbVboC2bzAr2ayd8x3xp2LnvFTYLD5s989t`
const DEVNET_DOC: DidDocumentLike = {
  id: DEVNET_HOLDER,
  verificationMethod: [
    {
      id: DEVNET_KEY,
      type: 'Ed25519VerificationKey2020',
      controller: DEVNET_HOLDER,
      publicKeyMultibase: 'z6MkovYXbVumDMbVboC2bzAr2ayd8x3xp2LnvFTYLD5s989t',
    },
  ],
  authentication: [DEVNET_KEY],
}
const DEVNET_VP: Record<string, unknown> = {
  id: 'https://ecs-org-issuer.devnet.verana.network/vt/ecs-org-vtc-vp.json',
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiablePresentation'],
  verifiableCredential: [
    {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://www.w3.org/ns/credentials/undefined-terms/v2',
      ],
      id: 'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network',
      type: ['VerifiableCredential', 'VerifiableTrustCredential'],
      issuer: 'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network',
      credentialSubject: {
        name: 'Verana ECS Organization Issuer',
        logoUri: 'https://veranacouncil.org/assets/img/favicon.svg',
        registryId: 'VERANA-ECS-ISSUER-001',
        registryUri: 'https://veranacouncil.org',
        address: 'Geneva, Switzerland',
        countryCode: 'CH',
        organizationKind: 'FOUNDATION',
        logoDigestSri: 'sha384-osSD4hnwIHnjjqhSoO+Fj1JZ+9MfLrJOYhZNZmu1ULMUxuSe8enWCVxSQyoIvlYO',
        id: 'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network',
      },
      validFrom: '2026-09-13T00:03:13.811Z',
      validUntil: '2036-09-10T00:03:13.811Z',
      credentialSchema: {
        id: 'https://ecs-ecosystem.devnet.verana.network/vt/schemas-29-jsc.json',
        type: 'JsonSchemaCredential',
      },
      proof: {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        verificationMethod:
          'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network#z6MkovYXbVumDMbVboC2bzAr2ayd8x3xp2LnvFTYLD5s989t',
        proofPurpose: 'assertionMethod',
        '@context': [
          'https://www.w3.org/ns/credentials/v2',
          'https://www.w3.org/ns/credentials/undefined-terms/v2',
        ],
        proofValue:
          'z3CCGV4eahYRnioFHrNHSKw4qV8wgg5rqbqwCrBNEEASM4F6wj4hUWdg2kaRmTQPNKwdnFxi7huf41ZAxggAeVTHn',
      },
    },
  ],
  holder: 'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network',
  proof: {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    verificationMethod:
      'did:webvh:QmPoUDrksDAsMAcpwJnDrMjgtKSu3T9Zf36M7ipmpX8wEA:ecs-org-issuer.devnet.verana.network#z6MkovYXbVumDMbVboC2bzAr2ayd8x3xp2LnvFTYLD5s989t',
    proofPurpose: 'authentication',
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    proofValue: 'z3ip9jN6batxxPgFvr5QJfLBZYcfQ3Y8PJRYiAn4hKCrvBtvKycvXD2SYGPmeTqj9EqTtjMYLFYRsnKeHhrngAhYc',
  },
}

describe('TG-DEREF-3 VP signature re-verification', () => {
  it('accepts a VP signed by the holder', async () => {
    const { key, doc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => doc)
    expect(verdict).toEqual({ verified: true })
  })

  it('rejects a tampered body', async () => {
    const { key, doc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    vp.holder = 'did:webvh:test:attacker.example'
    const verdict = await verifyVpSignature(vp, HOLDER, async () => doc)
    expect(verdict.verified).toBe(false)
  })

  it('rejects a signer key that is not in the holder DID document', async () => {
    const { key } = await makeHolder(HOLDER)
    const { doc: otherDoc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => otherDoc)
    expect(verdict.verified).toBe(false)
    expect(verdict.reason).toContain('not in holder DID document')
  })

  it('rejects a proof bound to a different DID', async () => {
    const { key, doc } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, 'did:webvh:test:someone.else', async () => doc)
    expect(verdict.verified).toBe(false)
    expect(verdict.reason).toContain('not the holder DID')
  })

  it('accepts a devnet VP signed with DataIntegrityProof eddsa-jcs-2022', async () => {
    const verdict = await verifyVpSignature(DEVNET_VP, DEVNET_HOLDER, async () => DEVNET_DOC)
    expect(verdict).toEqual({ verified: true })
    const tampered = { ...DEVNET_VP, holder: 'did:webvh:test:attacker.example' }
    expect((await verifyVpSignature(tampered, DEVNET_HOLDER, async () => DEVNET_DOC)).verified).toBe(false)
  })

  it('rejects when the DID document is unresolvable', async () => {
    const { key } = await makeHolder(HOLDER)
    const vp = await signVp(key, HOLDER)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => null)
    expect(verdict.verified).toBe(false)
  })
})
