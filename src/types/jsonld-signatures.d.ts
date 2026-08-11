declare module 'jsonld-signatures' {
  export interface DocumentLoaderResult {
    contextUrl: string | null
    document: unknown
    documentUrl: string
  }
  export type DocumentLoader = (url: string) => Promise<DocumentLoaderResult>
  export const purposes: {
    AssertionProofPurpose: new (options?: Record<string, unknown>) => unknown
  }
  export function verify(
    document: unknown,
    options: { suite: unknown; purpose: unknown; documentLoader: DocumentLoader },
  ): Promise<{ verified: boolean; error?: { errors?: Error[] } }>
  export function sign(
    document: unknown,
    options: { suite: unknown; purpose: unknown; documentLoader: DocumentLoader },
  ): Promise<unknown>
}

declare module '@digitalbazaar/ed25519-signature-2020' {
  export class Ed25519Signature2020 {
    constructor(options?: { key?: unknown })
  }
}

declare module '@digitalbazaar/ed25519-verification-key-2020' {
  export class Ed25519VerificationKey2020 {
    static from(options: {
      id: string
      controller: string
      publicKeyMultibase: string
    }): Promise<Ed25519VerificationKey2020>
    static generate(options?: {
      id?: string
      controller?: string
    }): Promise<Ed25519VerificationKey2020 & { publicKeyMultibase: string }>
  }
}
