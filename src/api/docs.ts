import { createReadStream, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { getAbsoluteFSPath } from 'swagger-ui-dist'

const components: Record<string, unknown> = {}

function rewriteRefs(node: unknown, prefix: string): unknown {
  if (Array.isArray(node)) return node.map(n => rewriteRefs(n, prefix))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] =
        k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')
          ? `#/components/schemas/${prefix}${v.slice('#/$defs/'.length)}`
          : rewriteRefs(v, prefix)
    }
    return out
  }
  return node
}

function loadSchema(name: string): Record<string, unknown> {
  const prefix = `${name.split('.')[0]}_${name.split('.')[1]}_`
  const url = new URL(`../../spec/graph/${name}`, import.meta.url)
  const schema = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>
  delete schema.$schema
  delete schema.$id
  const defs = (schema.$defs ?? {}) as Record<string, unknown>
  delete schema.$defs
  for (const [k, v] of Object.entries(defs)) components[`${prefix}${k}`] = rewriteRefs(v, prefix)
  return rewriteRefs(schema, prefix) as Record<string, unknown>
}

export function registerDocs(app: FastifyInstance): void {
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'Verana Graph API',
      description:
        'Query layer of the Verana trust registry. Search and traversal per the v4 Verana Graph specification, ingested live from the indexer.',
      version: (
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
          version: string
        }
      ).version,
    },
    paths: {
      '/health': {
        get: {
          summary: 'Service health and the last applied block',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/v4/graph/search': {
        post: {
          summary: 'Search a surface (TG-FCT-3, ranked, trusted-only by default)',
          description: `Ranked search over one surface of the graph. Trusted-only by default (TG-FCT-3), pass includeUntrusted to widen.

**surface** (required): \`Did\`, \`Ecosystem\`, \`Corporation\`, \`CredentialSchema\`, \`ServiceEndpoint\`

**freeText**: ranked full-text match on the surface.

**filters**: object keyed by field. A bare scalar means equals, an array means any-of, or pass an operator object (\`eq\`, \`in\`, \`prefix\`, \`range\`). Fields on the Did surface: \`Did.corporationId\`, \`Did.operatorKind\`, \`EcsCredential.ServiceCredential.type\`, \`EcsCredential.ServiceCredential.minimumAgeRequired\`, \`OrganizationCredential.countryCode\`, \`OrganizationCredential.legalJurisdiction\`, \`OrganizationCredential.organizationKind\`, \`OrganizationCredential.lei\`, \`OrganizationCredential.registryId\`, \`PersonaCredential.controllerCountryCode\`, \`PersonaCredential.controllerJurisdiction\`, \`Participant.ecosystemId\`, \`Participant.credentialSchemaId\`, \`Participant.role\`. An unknown field returns \`UNKNOWN_FILTER_FIELD\`.

**limit**: 1..500, default 100. **cursor**: opaque keyset cursor from the previous page, \`nextCursor\` is null on the last page (TG-QRY-6).`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: loadSchema('search.request.schema.json'),
                examples: {
                  ecosystems: {
                    summary: 'All ecosystems',
                    value: { surface: 'Ecosystem', limit: 5 },
                  },
                  freeText: {
                    summary: 'Free text over credential schemas',
                    value: { surface: 'CredentialSchema', freeText: 'organization', limit: 3 },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Ranked hits with keyset pagination',
              content: { 'application/json': { schema: loadSchema('search.response.schema.json') } },
            },
            '400': {
              description: 'TG-ERR-1 error envelope',
              content: { 'application/json': { schema: loadSchema('error.schema.json') } },
            },
          },
        },
      },
      '/v4/graph/traverse': {
        post: {
          summary: 'Traversal queries A1..G1 (TG-QRY-5 single binding)',
          description: `One endpoint, nineteen canonical queries (TG-QRY-3). Set \`query\` and give the matching \`input\`:

| query | returns | input (bold = required) |
|---|---|---|
| A1 | trust summary of a DID | **did** |
| A2 | governing chain: corporation + ecosystems | **did** |
| A3 | service endpoints | **did** |
| A4 | linked VPs and contained VTCs | **did** |
| A5 | credentials the DID holds | **did**, ecsSchema |
| A6 | credentials the DID issued | **did**, ecsSchema |
| A7 | participants of the DID by role | **did**, role |
| B1 | issuer recovery for a credential | **did**, **credentialId** |
| B2 | holder recovery for a credential | **did**, **credentialId** |
| C1 | schemas owned by an ecosystem | **ecosystemId** |
| C2 | participating DIDs grouped by role | **ecosystemId**, role, credentialSchemaId |
| C3 | ecosystem governance summary | **ecosystemId** |
| D1 | credentials based on a schema | **credentialSchemaId** |
| D2 | participating DIDs of a schema | **credentialSchemaId**, role |
| E1 | DIDs operated by a corporation | **corporationId** |
| E2 | ecosystems controlled by a corporation | **corporationId** |
| E3 | corporation governance summary | **corporationId** |
| F1 | path between two entities | **from**, **to** (EntityRef) |
| G1 | validator chain, root to leaf | **participantId** |

\`role\`: HOLDER, ISSUER, VERIFIER, ISSUER_GRANTOR, VERIFIER_GRANTOR, ECOSYSTEM. \`ecsSchema\`: ServiceCredential, OrganizationCredential, PersonaCredential, UserAgentCredential. \`EntityRef\`: \`{type, id}\` with type one of Did, Corporation, Ecosystem, CredentialSchema, Participant, EcsCredential, Vtc, LinkedVerifiablePresentation, ServiceEndpoint.

Collection queries take \`limit\` (1..500, default 100) and \`cursor\`. Non-ACTIVE participants appear in traversal with their true state while referenced (TG-ACT-1), search never returns them.

Errors (TG-ERR-1 envelope): \`INVALID_INPUT\`, \`UNKNOWN_QUERY\`, \`UNKNOWN_ID\`, \`UNKNOWN_FILTER_FIELD\`, \`INVALID_CURSOR\`.`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: loadSchema('traverse.request.schema.json'),
                examples: {
                  trustSummary: {
                    summary: 'A1 trust summary of a verified service',
                    value: {
                      query: 'A1',
                      input: {
                        did: 'did:webvh:QmSXfnquiRk1FELWULF82YqdaW6tpLK7TSCFKej1ZC7ZMG:organization-vs.example.demos.devnet.verana.network',
                      },
                    },
                  },
                  participantsByRole: {
                    summary: 'A7 participants of a DID, paginated',
                    value: {
                      query: 'A7',
                      input: {
                        did: 'did:webvh:QmZyuWxj9pnAzgvzZT4h2fZWknXVab9J5EEk911S6sMcXp:ecs-ecosystem.devnet.verana.network',
                      },
                      limit: 2,
                    },
                  },
                  validatorChain: {
                    summary: 'G1 validator chain, crosses a retained REVOKED participant',
                    value: { query: 'G1', input: { participantId: 10 } },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Query output with nextCursor',
              content: { 'application/json': { schema: loadSchema('traverse.response.schema.json') } },
            },
            '400': {
              description: 'TG-ERR-1 error envelope',
              content: { 'application/json': { schema: loadSchema('error.schema.json') } },
            },
          },
        },
      },
    },
    components: { schemas: components },
  }

  const assetRoot = getAbsoluteFSPath()
  app.get('/docs', async (_req, reply) =>
    reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(PAGE),
  )
  app.get('/docs/openapi.json', async (_req, reply) =>
    reply.header('cache-control', 'no-store').send(document),
  )
  app.get('/docs/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    if (!ASSETS.has(file)) {
      return reply.status(404).send({ error: { code: 'UNKNOWN_ID', message: 'unknown asset' } })
    }
    return reply
      .type(TYPES[extname(file)] ?? 'application/octet-stream')
      .send(createReadStream(join(assetRoot, file)))
  })
}

const ASSETS = new Set([
  'swagger-ui.css',
  'index.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-32x32.png',
  'favicon-16x16.png',
])

const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
}

const PAGE = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verana Graph API Docs</title>
    <link rel="icon" type="image/png" href="/docs/favicon-32x32.png" />
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script src="/docs/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function () {
        SwaggerUIBundle({
          url: '/docs/openapi.json',
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'BaseLayout',
        });
      };
    </script>
  </body>
</html>`
