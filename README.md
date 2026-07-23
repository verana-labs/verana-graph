# verana-graph

Implementation of the [Verana Graph specification](https://github.com/verana-labs/verana-spec/blob/main/v4/verana-graph/spec.md)
(v4-draft3): a read-only discovery index over the Verana Indexer. It mirrors the trust-relevant
state of every indexed DID into a typed graph and exposes three public surfaces:

- `POST /v4/graph/traverse`: the 19 canonical traversal queries (A1-G1)
- `POST /v4/graph/search`: hybrid faceted search over 5 entity surfaces
- `WS /v4/graph/blocks/subscribe`: block-progress notifications (one per committed block)

Stack: TypeScript, Fastify, `ws`, Knex + PostgreSQL. No ORM, no queue, one database serving both
the traversal and search projections.

## Run

```bash
docker compose up -d          # postgres on :5433
cp .env.example .env          # set INDEXER_BASE_URL to a running indexer
pnpm install
pnpm migrate
pnpm dev
```

The service bootstraps itself on first start (snapshot of the full DID universe at `ready.block - 1`),
then follows the indexer's change stream. Restarts resume from `lastAppliedBlock` via gap recovery;
no manual intervention.

## Configuration

See [.env.example](./.env.example). Notable flags: `FETCH_GF_DOC_BODIES` and `FETCH_VP_BODIES`
enable the optional resource fetching of TG-DEREF-2a/2b/3 (full-text search over governance
documents and domain-credential claims); `GATE_SERVICE_ENDPOINTS` applies owner trust gates on the
ServiceEndpoint search surface ahead of the spec settling that question.

## Test

```bash
docker compose up -d
pnpm test:all     # unit + e2e against a mock indexer implementing the documented contract
pnpm validate     # biome lint + tsc + format check
```

The e2e harness (`test/harness/`) is a scripted mock indexer (REST + WebSocket, At-Block-Height
aware). Every traversal and search response in the e2e suite is validated against the published
JSON Schemas vendored under `spec/`.

