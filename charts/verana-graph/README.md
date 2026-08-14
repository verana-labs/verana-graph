# verana-graph Helm chart

Deploys the Verana Graph discovery service, and — by default — its own PostgreSQL.

## Database

The graph keeps its own PostgreSQL projection (it is a read-only mirror of the indexer, reached
over HTTP/WS; it never connects to the indexer's database).

- **Self-contained (default)** — `database.enabled: true`: Postgres runs as a **sidecar container**
  in the graph's StatefulSet (same pattern as the indexer chart), with a retained volume via
  `volumeClaimTemplates`, and the app reaches it on `localhost:5432`. You only supply the password
  Secret (`database.pwdSecret`).
- **External** — `database.enabled: false`: no Postgres is deployed; set `database.host`/`port` to an
  existing server (e.g. a `verana_graph` database co-located on the indexer's Postgres).

The password is shared by the embedded Postgres and the app connection, and always comes from an
existing Kubernetes Secret referenced by `database.pwdSecret` (required) — never a plain-text value.

## Install

```bash
helm install graph ./charts/verana-graph --namespace verana --create-namespace \
  --set database.pwdSecret.name=graph-db --set database.pwdSecret.key=password

# external Postgres (e.g. on the indexer's server)
helm install graph ./charts/verana-graph --namespace verana --create-namespace \
  --set database.enabled=false --set database.host=idx \
  --set database.pwdSecret.name=verana-secrets --set database.pwdSecret.key=INDEXER_POSTGRES_PWD
```

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `replicaCount` | `1` | Graph replicas (keep at `1`: migrations run on boot) |
| `image.repository` | `veranalabs/verana-graph` | Image repository |
| `image.tag` | `""` | Defaults to `Chart.AppVersion` |
| `service.port` | `3100` | HTTP and WebSocket port (both on the same port) |
| `config.indexerBaseUrl` | `http://idx:3001` | Upstream indexer |
| `config.indexerWsUrl` | `""` | Derived from `config.indexerBaseUrl` when empty |
| `config.trustRefreshIntervalMs` | `"300000"` | Trust-refresh sweep, `"0"` disables it |
| `config.gateServiceEndpoints` | `"false"` | Gate ServiceEndpoint results on owner trust |
| `database.enabled` | `true` | Provision an in-cluster Postgres; set `false` for external |
| `database.host` | `""` | External Postgres host, used **only** when `enabled: false` |
| `database.pwdSecret` | `{}` | Secret holding the DB password, `{name, key}`. Required |
| `database.urlSecret` | `{}` | Secret holding the whole connection string, `{name, key}`. Takes precedence |
| `database.image.tag` | `"16-alpine"` | Embedded Postgres image tag (`enabled: true` only) |
| `database.storage.size` | `10Gi` | Embedded Postgres volume size |
| `database.storage.storageClassName` | `""` | `""` = cluster default; e.g. `csi-cinder-classic` on devnet |
| `ingress.enabled` | `false` | Publish an Ingress |
| `ingress.websocketTimeoutSeconds` | `3600` | Proxy timeout for the block-progress stream |

Numeric `config` values are quoted on purpose: Helm renders large YAML numbers in
scientific notation, and the service parses these with `parseInt`.

See `.env.example` in the repository root for the full application configuration surface.
