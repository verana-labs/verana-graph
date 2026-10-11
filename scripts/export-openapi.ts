import { mkdirSync, writeFileSync } from 'node:fs'
import { buildOpenApiDocument } from '../src/api/docs'

// Writes the document the service serves at /docs/openapi.json to docs/api/openapi.json, so
// that consumers (docs.verana.io) read the contract from the repository rather than a live
// instance. CI fails when the committed file is stale.
const out = new URL('../docs/api/openapi.json', import.meta.url)
mkdirSync(new URL('../docs/api/', import.meta.url), { recursive: true })
writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`)
console.log(`wrote ${out.pathname}`)
