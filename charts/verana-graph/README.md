# verana-graph Helm chart

Deploys the Verana Graph discovery service.

## Install

```bash
helm install graph ./charts/verana-graph --namespace verana --create-namespace \
  --set database.host=postgres.verana.svc.cluster.local \
  --set database.pwdSecret.name=graph-db --set database.pwdSecret.key=password
```

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `replicaCount` | `1` | Graph replicas |
| `image.repository` | `veranalabs/verana-graph` | Image repository |
| `image.tag` | `""` | Defaults to `Chart.AppVersion` |
| `service.port` | `3100` | HTTP and WebSocket port (both on the same port) |
| `config.indexerBaseUrl` | `http://idx:3001` | Upstream indexer |
| `config.indexerWsUrl` | `""` | Derived from `config.indexerBaseUrl` when empty |
| `config.trustRefreshIntervalMs` | `"300000"` | Trust-refresh sweep, `"0"` disables it |
| `database.pwdSecret` | `{}` | Secret holding the DB password, `{name, key}`. Required |
| `database.urlSecret` | `{}` | Secret holding the whole connection string, `{name, key}`. Takes precedence |
| `config.gateServiceEndpoints` | `"false"` | Gate ServiceEndpoint results on owner trust |
| `ingress.enabled` | `false` | Publish an Ingress |
| `ingress.websocketTimeoutSeconds` | `3600` | Proxy timeout for the block-progress stream |

Numeric `config` values are quoted on purpose: Helm renders large YAML numbers in
scientific notation, and the service parses these with `parseInt`.

See `.env.example` in the repository root for the full application configuration surface.
