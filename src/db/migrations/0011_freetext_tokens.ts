import type { Knex } from 'knex'

type Field = [expr: string, weight: 'A' | 'B' | 'C' | 'D']

const VECTORS: Record<string, Field[]> = {
  dids: [
    [`coalesce(sc_name, '') || ' ' || coalesce(sc_description, '')`, 'A'],
    [
      `coalesce(org_name, '') || ' ' || coalesce(org_address, '') || ' ' ||
        coalesce(persona_name, '') || ' ' || coalesce(persona_description, '') || ' ' ||
        coalesce(vtc_text, '')`,
      'B',
    ],
    [`coalesce(schema_text, '')`, 'C'],
  ],
  ecosystems: [
    [`coalesce(did_text, '')`, 'A'],
    [`coalesce(egf_text, '')`, 'D'],
  ],
  corporations: [
    [`coalesce(did_text, '')`, 'A'],
    [`coalesce(cgf_text, '')`, 'D'],
  ],
  credential_schemas: [[`coalesce(title, '') || ' ' || coalesce(description, '')`, 'C']],
}

// knex treats a bare ? as a binding, the jsonpath filter needs it escaped
const SERVICE_ENDPOINT: Field[] = [
  [
    `id || ' ' || type || ' ' ||
      jsonb_path_query_array(service_endpoint, 'strict $.** \\? (@.type() == "string")')::text`,
    'D',
  ],
]

function vector(fields: Field[], tokenize: boolean): string {
  return fields
    .map(
      ([expr, w]) =>
        `setweight(to_tsvector('simple', ${tokenize ? `search_tokens(${expr})` : expr}), '${w}')`,
    )
    .join(' || ')
}

async function rebuild(knex: Knex, table: string, expr: string): Promise<void> {
  await knex.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS search_vec`)
  await knex.raw(`ALTER TABLE ${table} ADD COLUMN search_vec tsvector GENERATED ALWAYS AS (${expr}) STORED`)
  await knex.raw(`CREATE INDEX ${table}_search_vec_idx ON ${table} USING GIN (search_vec)`)
}

// TG-FCT-4a: stored text and freeText share this tokenizer. [:punct:] rather than [^[:alnum:]] keeps
// non-ASCII letters whole on a C-locale database.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE FUNCTION search_tokens(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT regexp_replace(t, '[[:punct:][:space:]]+', ' ', 'g') $$`)
  for (const [table, fields] of Object.entries(VECTORS)) await rebuild(knex, table, vector(fields, true))
  await rebuild(knex, 'service_endpoints', vector(SERVICE_ENDPOINT, true))
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE service_endpoints DROP COLUMN search_vec')
  for (const [table, fields] of Object.entries(VECTORS)) await rebuild(knex, table, vector(fields, false))
  await knex.raw('DROP FUNCTION search_tokens(text)')
}
