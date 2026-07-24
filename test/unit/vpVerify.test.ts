import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020'
import jsigs from 'jsonld-signatures'
import { describe, expect, it } from 'vitest'
import { CONTEXTS, type DidDocumentLike, verifyVpSignature } from '../../src/deref/vpVerify.js'

const HOLDER = 'did:webvh:test:holder.example'

async function makeHolder() {
  const key = await Ed25519VerificationKey2020.generate()
  const keyed = key as Ed25519VerificationKey2020 & {
    publicKeyMultibase: string
    id: string
    controller: string
  }
  keyed.id = `${HOLDER}#${keyed.publicKeyMultibase}`
  keyed.controller = HOLDER
  const doc: DidDocumentLike = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: HOLDER,
    verificationMethod: [
      {
        id: keyed.id,
        type: 'Ed25519VerificationKey2020',
        controller: HOLDER,
        publicKeyMultibase: keyed.publicKeyMultibase,
      },
    ],
    assertionMethod: [keyed.id],
  }
  return { key: keyed, doc }
}

const loader: jsigs.DocumentLoader = async url => {
  if (Object.hasOwn(CONTEXTS, url)) return { contextUrl: null, document: CONTEXTS[url], documentUrl: url }
  throw new Error(`unexpected document ${url}`)
}

async function signVp(key: unknown, claims: Record<string, unknown> = {}) {
  const vp = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://www.w3.org/ns/credentials/examples/v2'],
    id: 'https://holder.example/vt/vp.json',
    type: ['VerifiablePresentation'],
    holder: HOLDER,
    ...claims,
  }
  return (await jsigs.sign(vp, {
    suite: new Ed25519Signature2020({ key }),
    purpose: new jsigs.purposes.AssertionProofPurpose(),
    documentLoader: loader,
  })) as Record<string, unknown>
}

describe('TG-DEREF-3 VP signature re-verification', () => {
  it('accepts a VP signed by the holder', async () => {
    const { key, doc } = await makeHolder()
    const vp = await signVp(key)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => doc)
    expect(verdict).toEqual({ verified: true })
  })

  it('rejects a tampered body', async () => {
    const { key, doc } = await makeHolder()
    const vp = await signVp(key)
    vp.holder = 'did:webvh:test:attacker.example'
    const verdict = await verifyVpSignature(vp, HOLDER, async () => doc)
    expect(verdict.verified).toBe(false)
  })

  it('rejects a signer key that is not in the holder DID document', async () => {
    const { key } = await makeHolder()
    const { doc: otherDoc } = await makeHolder()
    const vp = await signVp(key)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => otherDoc)
    expect(verdict.verified).toBe(false)
    expect(verdict.reason).toContain('not in holder DID document')
  })

  it('rejects a proof bound to a different DID', async () => {
    const { key, doc } = await makeHolder()
    const vp = await signVp(key)
    const verdict = await verifyVpSignature(vp, 'did:webvh:test:someone.else', async () => doc)
    expect(verdict.verified).toBe(false)
    expect(verdict.reason).toContain('not the holder DID')
  })

  it('rejects when the DID document is unresolvable', async () => {
    const { key } = await makeHolder()
    const vp = await signVp(key)
    const verdict = await verifyVpSignature(vp, HOLDER, async () => null)
    expect(verdict.verified).toBe(false)
  })
})
