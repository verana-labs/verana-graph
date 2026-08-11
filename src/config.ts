import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name]
  return v === undefined || v === '' ? def : v === 'true' || v === '1'
}

function int(name: string, def: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  const n = Number.parseInt(v, 10)
  if (Number.isNaN(n)) throw new Error(`Env var ${name} is not an integer: ${v}`)
  return n
}

export interface Config {
  databaseUrl: string
  indexerBaseUrl: string
  indexerWsUrl: string
  port: number
  fetchGfDocBodies: boolean
  fetchVpBodies: boolean
  gapCoalesceThreshold: number
  bpsMaxBufferedBytes: number
  gateServiceEndpoints: boolean
  trustRefreshIntervalMs: number
  trustRefreshBatch: number
  logLevel: string
}

export function loadConfig(): Config {
  const indexerBaseUrl = required('INDEXER_BASE_URL').replace(/\/$/, '')
  return {
    databaseUrl: required('DATABASE_URL'),
    indexerBaseUrl,
    indexerWsUrl: process.env.INDEXER_WS_URL || indexerBaseUrl.replace(/^http/, 'ws'),
    port: int('PORT', 3100),
    fetchGfDocBodies: bool('FETCH_GF_DOC_BODIES', false),
    fetchVpBodies: bool('FETCH_VP_BODIES', false),
    gapCoalesceThreshold: int('GAP_COALESCE_THRESHOLD', 1000),
    bpsMaxBufferedBytes: int('BPS_MAX_BUFFERED_BYTES', 1024 * 1024),
    gateServiceEndpoints: bool('GATE_SERVICE_ENDPOINTS', false),
    // 0 disables the sweep and follows the spec literally (event-driven resolves only)
    trustRefreshIntervalMs: int('TRUST_REFRESH_INTERVAL_MS', 0),
    trustRefreshBatch: int('TRUST_REFRESH_BATCH', 200),
    logLevel: process.env.LOG_LEVEL || 'info',
  }
}
