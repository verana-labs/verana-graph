import { createHash } from 'node:crypto'
import { Knex } from 'knex'
import { Config } from '../config'
import { IndexerRestClient } from '../indexer/rest'
import { GovernanceFramework, PresentationEntry } from '../indexer/types'
import { extractSubjectText } from '../ingest/denorm'
import { SchemaLoadRequest } from '../ingest/reconciler'
import { Logger } from '../util/logger'
import { type DidDocResolver, resolveWebvhDidDocument, verifyVpSignature } from './vpVerify'

export function digestSriOf(bytes: string, algo: 'sha256' | 'sha384' | 'sha512'): string {
  const hash = createHash(algo).update(bytes, 'utf8').digest('base64')
  return `${algo}-${hash}`
}

function algoOf(digestSri: string): 'sha256' | 'sha384' | 'sha512' | null {
  const m = digestSri.match(/^(sha256|sha384|sha512)-/)
  return m ? (m[1] as 'sha256' | 'sha384' | 'sha512') : null
}

// TG-DEREF-2/2a/2b/3/4: out-of-band resource fetching. Immutable resources (schema bodies,
// GF doc bodies) are fetched at most once ever; mutable VP bodies dedupe per (URL, block).
export class Dereferencer {
  private readonly vpFetchDedup = new Map<string, number>()

  constructor(
    private readonly db: Knex,
    private readonly rest: IndexerRestClient,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly resolveDidDoc: DidDocResolver = resolveWebvhDidDocument,
  ) {}

  // TG-DEREF-2 step 1: load once, validate against digestSri, then insert the record. The row
  // never exists without a body. Failures are logged and retried on the next surfacing.
  async loadSchemas(requests: SchemaLoadRequest[]): Promise<void> {
    for (const req of requests) {
      try {
        await this.loadSchema(req)
      } catch (err) {
        this.log.warn({ schemaId: req.schemaId, err: (err as Error).message }, 'schema load failed')
      }
    }
  }

  private async loadSchema(req: SchemaLoadRequest): Promise<void> {
    const exists = await this.db('credential_schemas').where('id', req.schemaId).first('id')
    if (exists) return
    const { raw, parsed } = await this.rest.loadSchemaBody(req.schemaId, req.evidence.block)
    const algo = algoOf(req.digestSri)
    if (algo) {
      const actual = digestSriOf(raw, algo)
      if (actual !== req.digestSri) {
        throw new Error(
          `digestSri mismatch for schema ${req.schemaId}: expected ${req.digestSri}, got ${actual}`,
        )
      }
    }
    const body = parsed as Record<string, unknown>
    await this.db('credential_schemas')
      .insert({
        id: req.schemaId,
        type: req.type,
        digest_sri: req.digestSri,
        archived: req.archived,
        ecosystem_id: req.ecosystemId,
        body: raw,
        title: typeof body.title === 'string' ? body.title : null,
        description: typeof body.description === 'string' ? body.description : null,
        last_observed_at_time: req.evidence.blockTime,
        last_observed_at_block: req.evidence.block,
      })
      .onConflict('id')
      .ignore()
    await this.db.raw(
      `
      UPDATE dids SET schema_text = sub.text FROM (
        SELECT p.did_id, string_agg(DISTINCT concat_ws(' ', cs.title, cs.description), ' ') AS text
        FROM participants p JOIN credential_schemas cs ON cs.id = p.credential_schema_id
        WHERE p.did_id IN (SELECT did_id FROM participants WHERE credential_schema_id = ?)
        GROUP BY p.did_id
      ) sub WHERE dids.did = sub.did_id
      `,
      [req.schemaId],
    )
  }

  // TG-DEREF-2a/2b: GF document bodies, cached globally by digestSri, shared CGF/EGF cache
  async fetchGfDocs(kind: 'cgf' | 'egf', ownerId: number, gf: GovernanceFramework | null): Promise<void> {
    if (!this.config.fetchGfDocBodies || !gf) return
    for (const doc of gf.documents) {
      const cached = await this.db('gf_doc_bodies').where('digest_sri', doc.digestSri).first('digest_sri')
      if (cached) continue
      try {
        const res = await fetch(doc.url)
        if (!res.ok) continue
        const body = await res.text()
        const algo = algoOf(doc.digestSri)
        if (algo && digestSriOf(body, algo) !== doc.digestSri) {
          this.log.warn({ url: doc.url }, 'gf doc digest mismatch, skipping')
          continue
        }
        await this.db('gf_doc_bodies')
          .insert({ digest_sri: doc.digestSri, url: doc.url, body, fetched_at: new Date().toISOString() })
          .onConflict('digest_sri')
          .ignore()
      } catch (err) {
        this.log.warn({ url: doc.url, err: (err as Error).message }, 'gf doc fetch failed')
      }
    }
    const table = kind === 'cgf' ? 'corporations' : 'ecosystems'
    const column = kind === 'cgf' ? 'cgf_text' : 'egf_text'
    await this.db.raw(
      `
      UPDATE ${table} t SET ${column} = sub.text FROM (
        SELECT string_agg(b.body, ' ') AS text FROM gf_doc_bodies b
        WHERE b.digest_sri IN (
          SELECT jsonb_array_elements(t2.${kind}->'documents')->>'digestSri'
          FROM ${table} t2 WHERE t2.id = ?
        )
      ) sub WHERE t.id = ?
      `,
      [ownerId, ownerId],
    )
  }

  // TG-DEREF-3 optional VP body fetch, deduplicated per (URL, block) (TG-DEREF-4 mutable tier).
  // The fetched body is holder-controlled: its signature is re-verified against the holder's
  // DID Document before any claim is extracted (TG-DEREF-3).
  async fetchVpBodies(did: string, presentations: PresentationEntry[], block: number): Promise<void> {
    if (!this.config.fetchVpBodies) return
    for (const p of presentations) {
      if (this.vpFetchDedup.get(p.id) === block) continue
      this.vpFetchDedup.set(p.id, block)
      try {
        const res = await fetch(p.id)
        if (!res.ok) continue
        const vp = (await res.json()) as { verifiableCredential?: unknown[] }
        const verdict = await verifyVpSignature(vp as Record<string, unknown>, did, this.resolveDidDoc)
        if (!verdict.verified) {
          this.log.warn({ vp: p.id, reason: verdict.reason }, 'vp signature re-verification failed')
          continue
        }
        const creds = Array.isArray(vp.verifiableCredential) ? vp.verifiableCredential : []
        const wanted = new Map(p.vtcCredentials.map(v => [v.id, v]))
        for (const cred of creds) {
          const c = cred as { id?: string; credentialSubject?: Record<string, unknown> }
          if (!c.id || !wanted.has(c.id) || !c.credentialSubject) continue
          const text = extractSubjectText(c.credentialSubject)
          if (text) await this.db('vtcs').where('id', c.id).update({ subject_text: text })
        }
      } catch (err) {
        this.log.warn({ vp: p.id, err: (err as Error).message }, 'vp body fetch failed')
      }
    }
    await this.db.raw(
      `
      UPDATE dids SET vtc_text = sub.text FROM (
        SELECT l.did_id, string_agg(DISTINCT v.subject_text, ' ') AS text
        FROM vtcs v JOIN lvp_vtcs lv ON lv.vtc_id = v.id JOIN linked_vps l ON l.id = lv.lvp_id
        WHERE l.did_id = ? AND v.subject_text IS NOT NULL GROUP BY l.did_id
      ) sub WHERE dids.did = sub.did_id
      `,
      [did],
    )
  }
}
