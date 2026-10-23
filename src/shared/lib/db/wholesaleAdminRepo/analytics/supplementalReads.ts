import { analyticsQuery } from './performance';

export type PeriodComparisonRow = {
  current_prices: string;
  previous_prices: string;
  current_views: string;
  previous_views: string;
  current_pdf: string;
  previous_pdf: string;
  current_requests: string;
  previous_requests: string;
};

export function readPeriodComparison(managerId: number | null, interval: string | null) {
  const params = managerId ? [interval, managerId] : [interval];
  const managerClause = managerId ? 'and manager_id = $2' : '';
  const eventManagerClause = managerId ? 'and e.manager_id = $2' : '';
  // Global filtered index scans were faster than a broad aggregate in the
  // synthetic benchmark; retain those. The manager-scoped path below benefits
  // from combining repeated scans of the same manager_id range.
  if (!managerId) return analyticsQuery<PeriodComparisonRow>('readPeriodComparison',
    `select
       (select count(*)::text from wholesale_price_lists where created_at >= now() - $1::interval ) as current_prices,
       (select count(*)::text from wholesale_price_lists where created_at >= now() - ($1::interval * 2) and created_at < now() - $1::interval ) as previous_prices,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - $1::interval ) as current_views,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ) as previous_views,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - $1::interval ) as current_pdf,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ) as previous_pdf,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_request_sent' and e.created_at >= now() - $1::interval ) as current_requests,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_request_sent' and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ) as previous_requests`, params);
  return analyticsQuery<PeriodComparisonRow>("readPeriodComparison",
    `select prices.*, events.* from (
       select
         count(*) filter (where created_at >= now() - $1::interval)::text as current_prices,
         count(*) filter (where created_at < now() - $1::interval)::text as previous_prices
       from wholesale_price_lists
       where created_at >= now() - ($1::interval * 2) ${managerClause}
     ) prices cross join (
       select
         count(*) filter (where e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - $1::interval)::text as current_views,
         count(*) filter (where e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at < now() - $1::interval)::text as previous_views,
         count(*) filter (where e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - $1::interval)::text as current_pdf,
         count(*) filter (where e.event_type = 'public_price_pdf_downloaded' and e.created_at < now() - $1::interval)::text as previous_pdf,
         count(*) filter (where e.event_type = 'public_price_request_sent' and e.created_at >= now() - $1::interval)::text as current_requests,
         count(*) filter (where e.event_type = 'public_price_request_sent' and e.created_at < now() - $1::interval)::text as previous_requests
       from wholesale_analytics_events e
       where e.actor_type = 'client' and e.created_at >= now() - ($1::interval * 2)
         and e.event_type in ('public_price_opened', 'public_price_reopened', 'public_price_pdf_downloaded', 'public_price_request_sent')
         ${eventManagerClause}
     ) events`,
    params,
  );
}

export type ProductInterestRow = {
  product_title: string;
  product_id: string | null;
  opens: string;
  quantity_changes: string;
  requests: string;
  last_activity_at: string | null;
};

export function readProductInterest(managerId: number | null, interval: string | null) {
  const params = managerId ? [interval, managerId] : [interval];
  const managerClause = managerId ? 'and e.manager_id = $2' : '';
  return analyticsQuery<ProductInterestRow>("readProductInterest",
    `with event_products as (
       select
         nullif(e.metadata->>'productTitle', '') as product_title,
         nullif(e.metadata->>'productId', '') as product_id,
         e.event_type,
         e.created_at
       from wholesale_analytics_events e
       where e.actor_type = 'client'
         and e.event_type in ('public_price_product_opened', 'public_price_quantity_changed')
         and ($1::text is null or e.created_at >= now() - $1::interval)
         ${managerClause}
       union all
       select
         nullif(item->>'productTitle', '') as product_title,
         null::text as product_id,
         'public_price_request_sent' as event_type,
         e.created_at
       from wholesale_analytics_events e
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(e.metadata->'items') = 'array' then e.metadata->'items' else '[]'::jsonb end
       ) item
       where e.actor_type = 'client'
         and e.event_type = 'public_price_request_sent'
         and ($1::text is null or e.created_at >= now() - $1::interval)
         ${managerClause}
     )
     select
       coalesce(product_title, 'Товар') as product_title,
       product_id,
       count(*) filter (where event_type = 'public_price_product_opened')::text as opens,
       count(*) filter (where event_type = 'public_price_quantity_changed')::text as quantity_changes,
       count(*) filter (where event_type = 'public_price_request_sent')::text as requests,
       max(created_at)::text as last_activity_at
     from event_products
     group by coalesce(product_title, 'Товар'), product_id
     order by
       (count(*) filter (where event_type = 'public_price_request_sent')) desc,
       (count(*) filter (where event_type = 'public_price_quantity_changed')) desc,
       (count(*) filter (where event_type = 'public_price_product_opened')) desc
     limit 15`,
    params,
  );
}
