import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    delete from service_endpoints r
    using service_endpoints a
    where r.id like '#%' and a.id = r.did_id || r.id
  `)
  await knex.raw(`update service_endpoints set id = did_id || id where id like '#%'`)
  await knex.raw(`update linked_vps set service_id = did_id || service_id where service_id like '#%'`)
  await knex.raw(`
    update dids set service_types = array(
      select t from unnest(service_types) with ordinality u(t, n) group by t order by min(n)
    )
    where cardinality(service_types) > (select count(distinct t) from unnest(service_types) t)
  `)
}

export async function down(): Promise<void> {
  // irreversible: the rows do not record which ids were relative
}
