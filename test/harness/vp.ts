import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020'
import { Ed25519VerificationKey2020 } from '@digitalbazaar/ed25519-verification-key-2020'
import jsigs from 'jsonld-signatures'
import { CONTEXTS, type DidDocumentLike } from '../../src/deref/vpVerify'

export type HolderKey = Ed25519VerificationKey2020 & {
  publicKeyMultibase: string
  id: string
  controller: string
}

export async function makeHolder(did: string): Promise<{ key: HolderKey; doc: DidDocumentLike }> {
  const key = await Ed25519VerificationKey2020.generate()
  const keyed = key as HolderKey
  keyed.id = `${did}#${keyed.publicKeyMultibase}`
  keyed.controller = did
  const doc: DidDocumentLike = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
    id: did,
    verificationMethod: [
      {
        id: keyed.id,
        type: 'Ed25519VerificationKey2020',
        controller: did,
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

export async function signVp(
  key: unknown,
  holder: string,
  claims: Record<string, unknown> = {},
  purpose: unknown = new jsigs.purposes.AssertionProofPurpose(),
): Promise<Record<string, unknown>> {
  const vp = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://www.w3.org/ns/credentials/examples/v2'],
    id: 'https://holder.example/vt/vp.json',
    type: ['VerifiablePresentation'],
    holder,
    ...claims,
  }
  return (await jsigs.sign(vp, {
    suite: new Ed25519Signature2020({ key }),
    purpose,
    documentLoader: loader,
  })) as Record<string, unknown>
}
