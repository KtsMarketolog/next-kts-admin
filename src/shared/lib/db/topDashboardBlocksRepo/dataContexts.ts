import type { Queryable } from './records';

/** Called only under the block lock during a successful mutation, never on reads. */
export async function initializeDashboardDataContexts(client: Queryable, blockId: number) {
  // Older inactive HTMLs had no persisted pointers. Initialize only missing contexts
  // deterministically; once saved, a rollback selection must outrank upload order.
  await client.query(
    `with ranked as (
       select versions.id, versions.bound_html_version_id,
         case when versions.bound_html_version_id is not null
           then 'html:' || versions.bound_html_version_id::text
           else versions.snapshot_format || ':' || versions.dashboard_profile
         end as context_key,
         row_number() over (
           partition by versions.snapshot_format, versions.dashboard_profile, versions.bound_html_version_id
           order by case when versions.id = state.active_version_id then 0
                         when versions.id = state.previous_version_id then 1 else 2 end,
                    versions.created_at desc, versions.id desc
         ) as position
       from top_dashboard_block_data_versions versions
       join top_dashboard_block_data_state state on state.block_id = versions.block_id
       where versions.block_id = $1
     )
     insert into top_dashboard_block_data_context_state
       (block_id, context_key, bound_html_version_id, active_version_id, previous_version_id)
     select $1, context_key, bound_html_version_id,
       max(id) filter (where position = 1), max(id) filter (where position = 2)
     from ranked where position <= 2 group by context_key, bound_html_version_id
     on conflict (block_id, context_key) do nothing`,
    [blockId],
  );
  await saveDashboardDataContext(client, blockId);
}

/** The published global pointers are authoritative for the currently selected context. */
export async function saveDashboardDataContext(client: Queryable, blockId: number) {
  await client.query(
    `insert into top_dashboard_block_data_context_state
       (block_id, context_key, bound_html_version_id, active_version_id, previous_version_id)
     select state.block_id,
       case when active.bound_html_version_id is not null
         then 'html:' || active.bound_html_version_id::text
         else active.snapshot_format || ':' || active.dashboard_profile
       end,
       active.bound_html_version_id, active.id, previous.id
     from top_dashboard_block_data_state state
     join top_dashboard_block_data_versions active
       on active.block_id = state.block_id and active.id = state.active_version_id
     left join top_dashboard_block_data_versions previous
       on previous.block_id = state.block_id and previous.id = state.previous_version_id
       and previous.snapshot_format = active.snapshot_format
       and previous.dashboard_profile = active.dashboard_profile
       and previous.bound_html_version_id is not distinct from active.bound_html_version_id
     where state.block_id = $1
     on conflict (block_id, context_key) do update
       set active_version_id = excluded.active_version_id,
           previous_version_id = excluded.previous_version_id`,
    [blockId],
  );
}
