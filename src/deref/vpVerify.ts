import { readFileSync } from 'node:fs'
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020'
import { resolveDID } from 'didwebvh-ts'
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
}

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

export async function resolveWebvhDidDocument(did: string): Promise<DidDocumentLike | null> {
  const { doc } = await resolveDID(did)
  return (doc as DidDocumentLike) ?? null
}

function methodFromDoc(doc: DidDocumentLike, methodId: string): VerificationMethodLike | null {
  const inVm = doc.verificationMethod?.find(m => m.id === methodId)
  if (inVm) return inVm
  const inAssertion = doc.assertionMethod?.find(m => typeof m !== 'string' && m.id === methodId)
  return typeof inAssertion === 'object' ? inAssertion : null
}

// the assertionMethod relationship may reference the method by id string or embed it
function assertionAllows(doc: DidDocumentLike, methodId: string): boolean {
  if (!doc.assertionMethod) return doc.verificationMethod?.some(m => m.id === methodId) ?? false
  return doc.assertionMethod.some(m => (typeof m === 'string' ? m === methodId : m.id === methodId))
}

export async function verifyVpSignature(
  vp: Json,
  holderDid: string,
  resolveDoc: DidDocResolver,
): Promise<{ verified: boolean; reason?: string }> {
  const proof = vp.proof as { verificationMethod?: string; type?: string } | undefined
  const methodId = proof?.verificationMethod
  if (!methodId) return { verified: false, reason: 'missing proof.verificationMethod' }
  if (proof?.type !== 'Ed25519Signature2020') {
    return { verified: false, reason: `unsupported proof type ${proof?.type}` }
  }
  if (methodId.split('#')[0] !== holderDid) {
    return { verified: false, reason: 'proof verificationMethod is not the holder DID' }
  }
  if ((proof as { proofPurpose?: string }).proofPurpose !== 'assertionMethod') {
    return { verified: false, reason: 'proof purpose is not assertionMethod' }
  }

  const doc = await resolveDoc(holderDid)
  if (!doc) return { verified: false, reason: 'holder DID document unresolvable' }
  const method = methodFromDoc(doc, methodId)
  if (!method?.publicKeyMultibase) {
    return { verified: false, reason: 'verification method not in holder DID document' }
  }
  if (!assertionAllows(doc, methodId)) {
    return { verified: false, reason: 'verification method not authorized for assertion' }
  }

  const key = await Ed25519VerificationKey2020.from({
    id: method.id,
    controller: method.controller ?? holderDid,
    publicKeyMultibase: method.publicKeyMultibase,
  })
  // the method's membership and assertion authorization were checked natively against the real
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
  const { proof: _omit, ...documentWithoutProof } = vp
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
