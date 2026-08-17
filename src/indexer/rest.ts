import { ListChangesResponse, ListDidsResponse, ResolveResponse } from './types'

export class IndexerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`Indexer request failed: ${status} ${url} ${body.slice(0, 200)}`)
  }
}

// TG-INGEST-2: the one canonical resolve request body every call site uses
export function canonicalResolveBody(did: string): Record<string, unknown> {
  return {
    did,
    corporation: true,
    participations: { states: ['ACTIVE', 'FUTURE', 'INACTIVE', 'EXPIRED', 'REVOKED', 'SLASHED', 'REPAID'] },
    ecsCredentials: true,
    services: true,
    presentations: true,
    ecosystems: {
      includeArchived: true,
      credentialSchemas: { includeArchived: true },
    },
  }
}

export class IndexerRestClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, atBlockHeight?: number, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(atBlockHeight !== undefined ? { 'at-block-height': String(atBlockHeight) } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) throw new IndexerHttpError(res.status, url, await res.text())
    return (await res.json()) as T
  }

  async resolve(did: string, atBlockHeight: number): Promise<ResolveResponse> {
    return this.request<ResolveResponse>('/v4/verifiable-trust/resolve', atBlockHeight, {
      method: 'POST',
      body: JSON.stringify(canonicalResolveBody(did)),
    })
  }

  async listDids(atBlockHeight: number, cursor?: string): Promise<ListDidsResponse> {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return this.request<ListDidsResponse>(`/v4/verifiable-trust/dids${qs}`, atBlockHeight)
  }

  async *enumerateDids(atBlockHeight: number): AsyncGenerator<string> {
    let cursor: string | undefined
    do {
      const page = await this.listDids(atBlockHeight, cursor)
      for (const did of page.dids) yield did
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }

  async listChanges(fromBlock: number, atBlockHeight?: number): Promise<ListChangesResponse> {
    // channels is documented optional but the shipped indexer requires it; being explicit is
    // correct under both readings and matches the graph's all-channels subscription
    const channels = 'trust,corporation,participations,ecsCredentials,presentations,services,ecosystems'
    return this.request<ListChangesResponse>(
      `/v4/verifiable-trust/changes?fromBlock=${fromBlock}&channels=${channels}`,
      atBlockHeight,
    )
  }

  // raw text is needed so the digestSri check hashes the exact served bytes (TG-DEREF-2)
  async loadSchemaBody(schemaId: number, atBlockHeight: number): Promise<{ raw: string; parsed: unknown }> {
    const url = `${this.baseUrl}/v4/credential-schema/js/${schemaId}`
    const res = await fetch(url, { headers: { 'at-block-height': String(atBlockHeight) } })
    if (!res.ok) throw new IndexerHttpError(res.status, url, await res.text())
    const raw = await res.text()
    return { raw, parsed: JSON.parse(raw) }
  }
}
