import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020'
import {
  type DataIntegrityProofTemplate,
  multibaseDecode,
  prepareDataForSigning,
  resolveDID,
} from 'didwebvh-ts'
import jsigs from 'jsonld-signatures'

// TG-DEREF-3: a fetched VP body is holder-controlled and MUST have its signature re-verified
// against the holder's DID Document before any claim is extracted from it.

type Json = Record<string, unknown>

export interface VerificationMethodLike {
  id: string
  type?: string
  controller?: string
  publicKeyMultibase?: string
}

export interface DidDocumentLike {
  '@context'?: unknown
  id: string
  verificationMethod?: VerificationMethodLike[]
  assertionMethod?: (string | VerificationMethodLike)[]
  authentication?: (string | VerificationMethodLike)[]
}

type Relationship = 'assertionMethod' | 'authentication'

export type DidDocResolver = (did: string) => Promise<DidDocumentLike | null>

export const CONTEXTS: Record<string, unknown> = {
  'https://www.w3.org/2018/credentials/v1': loadContext('credentials-v1.json'),
  'https://www.w3.org/ns/credentials/examples/v2': loadContext('credentials-examples-v2.json'),
  'https://w3id.org/security/suites/ed25519-2020/v1': loadContext('ed25519-2020-v1.json'),
  'https://www.w3.org/ns/did/v1': loadContext('did-v1.json'),
  'https://w3id.org/security/multikey/v1': loadContext('multikey-v1.json'),
}

function loadContext(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./contexts/${name}`, import.meta.url), 'utf8'))
}

const ed25519Verifier = {
  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    const x = Buffer.from(publicKey).toString('base64url')
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
    return verify(null, message, key, signature)
  },
}

export async function resolveWebvhDidDocument(did: string): Promise<DidDocumentLike | null> {
  const { doc } = await resolveDID(did, { verifier: ed25519Verifier })
  return (doc as DidDocumentLike) ?? null
}

function methodFromDoc(
  doc: DidDocumentLike,
  methodId: string,
  relationship: Relationship,
): VerificationMethodLike | null {
  const inVm = doc.verificationMethod?.find(m => m.id === methodId)
  if (inVm) return inVm
  const embedded = doc[relationship]?.find(m => typeof m !== 'string' && m.id === methodId)
  return typeof embedded === 'object' ? embedded : null
}

// a relationship may reference the method by id string or embed it
function relationshipAllows(doc: DidDocumentLike, relationship: Relationship, methodId: string): boolean {
  return doc[relationship]?.some(m => (typeof m === 'string' ? m === methodId : m.id === methodId)) ?? false
}

function decodeProofValue(proofValue: unknown): Uint8Array | null {
  if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) return null
  try {
    return multibaseDecode(proofValue).bytes
  } catch {
    return null
  }
}

function contextStartsWith(documentContext: unknown, proofContext: unknown): boolean {
  const document = Array.isArray(documentContext) ? documentContext : [documentContext]
  const prefix = Array.isArray(proofContext) ? proofContext : [proofContext]
  return isDeepStrictEqual(document.slice(0, prefix.length), prefix)
}

export async function verifyVpSignature(
  vp: Json,
  holderDid: string,
  resolveDoc: DidDocResolver,
): Promise<{ verified: boolean; reason?: string }> {
  const proof = vp.proof as
    | { verificationMethod?: string; type?: string; cryptosuite?: string; proofPurpose?: string }
    | undefined
  const methodId = proof?.verificationMethod
  if (!methodId) return { verified: false, reason: 'missing proof.verificationMethod' }
  const eddsaJcs = proof?.type === 'DataIntegrityProof' && proof.cryptosuite === 'eddsa-jcs-2022'
  if (!eddsaJcs && proof?.type !== 'Ed25519Signature2020') {
    const cryptosuite = proof?.cryptosuite ? ` ${proof.cryptosuite}` : ''
    return { verified: false, reason: `unsupported proof type ${proof?.type}${cryptosuite}` }
  }
  if (methodId.split('#')[0] !== holderDid) {
    return { verified: false, reason: 'proof verificationMethod is not the holder DID' }
  }
  const purpose = proof?.proofPurpose
  if (purpose !== 'assertionMethod' && purpose !== 'authentication') {
    return { verified: false, reason: `unsupported proof purpose ${purpose}` }
  }

  const doc = await resolveDoc(holderDid)
  if (!doc) return { verified: false, reason: 'holder DID document unresolvable' }
  const method = methodFromDoc(doc, methodId, purpose)
  if (!method?.publicKeyMultibase) {
    return { verified: false, reason: 'verification method not in holder DID document' }
  }
  if (!relationshipAllows(doc, purpose, methodId)) {
    return { verified: false, reason: `verification method not authorized for ${purpose}` }
  }

  const { proof: _omit, ...documentWithoutProof } = vp
  if (eddsaJcs) {
    const publicKey = multibaseDecode(method.publicKeyMultibase).bytes
    if (publicKey[0] !== 0xed || publicKey[1] !== 0x01) {
      return { verified: false, reason: 'verification method is not an Ed25519 key' }
    }
    const { proofValue, ...proofOptions } = proof as Json
    const signature = decodeProofValue(proofValue)
    if (!signature) return { verified: false, reason: 'malformed proof.proofValue' }
    // https://www.w3.org/TR/vc-di-eddsa/#verify-proof-eddsa-jcs-2022 step 4
    if (proofOptions['@context'] !== undefined) {
      if (!contextStartsWith(vp['@context'], proofOptions['@context'])) {
        return { verified: false, reason: 'proof @context is not a prefix of the document @context' }
      }
      documentWithoutProof['@context'] = proofOptions['@context']
    }
    const data = await prepareDataForSigning(
      documentWithoutProof,
      proofOptions as unknown as DataIntegrityProofTemplate,
    )
    if (await ed25519Verifier.verify(signature, data, publicKey.slice(2))) return { verified: true }
    return { verified: false, reason: 'signature verification failed' }
  }

  const key = await Ed25519VerificationKey2020.from({
    id: method.id,
    controller: method.controller ?? holderDid,
    publicKeyMultibase: method.publicKeyMultibase,
  })
  // the method's membership and relationship authorization were checked natively against the real
  // resolved document above; jsigs only needs a context-clean controller doc restating them
  // (real DID documents reference arbitrary contexts this verifier does not vendor)
  const ed25519Method = {
    '@context': 'https://w3id.org/security/suites/ed25519-2020/v1',
    id: method.id,
    type: 'Ed25519VerificationKey2020',
    controller: holderDid,
    publicKeyMultibase: method.publicKeyMultibase,
  }
  const controllerDoc = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: holderDid,
    assertionMethod: [method.id],
    verificationMethod: [ed25519Method],
  }
  const documentLoader: jsigs.DocumentLoader = async url => {
    if (Object.hasOwn(CONTEXTS, url)) {
      return { contextUrl: null, document: CONTEXTS[url], documentUrl: url }
    }
    if (url === holderDid) return { contextUrl: null, document: controllerDoc, documentUrl: url }
    if (url === method.id) return { contextUrl: null, document: ed25519Method, documentUrl: url }
    throw new Error(`refusing to load remote document ${url}`)
  }

  // suite.verifyProof directly instead of jsigs.verify: jsigs' proof discovery compacts the
  // proof type under the VP's own contexts, which filters out proofs signed by stacks that do
  // not embed the suite context in the proof node (credo/vs-agent). Verified against real
  // agent-signed VPs; tampering still fails with an invalid signature.
  const proofNode = { ...(proof as Json), '@context': vp['@context'] }
  const suite = new Ed25519Signature2020({ key }) as unknown as {
    verifyProof(options: Json): Promise<{ verified: boolean; error?: Error }>
  }
  const result = await suite.verifyProof({
    proof: proofNode,
    document: documentWithoutProof,
    purpose: new jsigs.purposes.AssertionProofPurpose(),
    documentLoader,
    proofSet: [proofNode],
  })
  if (result.verified) return { verified: true }
  return { verified: false, reason: result.error?.message ?? 'signature verification failed' }
}
