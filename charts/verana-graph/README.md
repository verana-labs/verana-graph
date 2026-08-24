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

### Self-contained — the chart brings its own Postgres (default)

The password Secret both **seeds** the embedded Postgres and is what the app connects with, so
create it first, then install:

```bash
kubectl create namespace verana

# the value initialises the embedded Postgres on first boot
kubectl -n verana create secret generic graph-db \
  --from-literal=password="$(openssl rand -base64 24)"

helm install graph ./charts/verana-graph --namespace verana \
  --set database.pwdSecret.name=graph-db \
  --set database.pwdSecret.key=password
  # --set database.storage.storageClassName=<class>   # if your cluster has no default StorageClass
```

That's it — the graph and its PostgreSQL come up in one pod, the volume persists across upgrades.

### External Postgres (e.g. a `verana_graph` database on the indexer's server)

```bash
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
| `database.storage.size` | `2Gi` | Embedded Postgres volume size, see Storage sizing below |
| `database.storage.storageClassName` | `""` | `""` = cluster default; e.g. `csi-cinder-classic` on devnet |
| `ingress.enabled` | `false` | Publish an Ingress |
| `ingress.websocketTimeoutSeconds` | `3600` | Proxy timeout for the block-progress stream |

### Storage sizing

The graph stores current state only, never per block history, so the database grows with the number of DIDs, participants and credentials, not with chain age. Measured on the current schema: an empty database is 8.7 MB and a 4,500 DID world with 5,100 participants and 4,200 credentials is 26 MB, about 4 KB per DID with everything it brings along. The volume also holds the postgres base files (about 50 MB) and WAL, which is capped at 1 GB by default and dominates at this scale. The 2Gi default covers roughly 100k DIDs with margin. Revisit it when the network approaches that.

Numeric `config` values are quoted on purpose: Helm renders large YAML numbers in
scientific notation, and the service parses these with `parseInt`.

See `.env.example` in the repository root for the full application configuration surface.
