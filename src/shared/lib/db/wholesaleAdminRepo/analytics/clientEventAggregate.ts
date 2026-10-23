/** Compile-time SQL fragments only. Never interpolate request values here. */
export function clientEventAggregate(intervalParameter: '$1' | '$2') {
  const inPeriod = `(${intervalParameter}::text is null or e.created_at >= now() - ${intervalParameter}::interval)`;
  const view = "e.event_type in ('public_price_opened', 'public_price_reopened')";
  const pdf = "e.event_type = 'public_price_pdf_downloaded'";
  const excel = "e.event_type = 'public_price_excel_downloaded'";
  const request = "e.event_type = 'public_price_request_sent'";
  const count = (condition: string) => `count(*) filter (where ${condition})::integer`;
  const distinct = (condition: string) => `count(distinct nullif(e.session_id, '')) filter (where ${condition})::integer`;
  return `left join lateral (
       select
         ${count(view)} as views,
         ${count(`${view} and e.created_at >= now() - interval '7 days'`)} as views_last_7_days,
         ${count(`${view} and e.created_at >= now() - interval '30 days'`)} as views_last_30_days,
         ${count(`${view} and ${inPeriod}`)} as views_period,
         max(e.created_at) filter (where ${view}) as last_view_at,
         min(e.created_at) filter (where ${view}) as first_view_at,
         ${distinct(`${view} and ${inPeriod}`)} as unique_visitors,
         ${count(`e.event_type = 'public_price_reopened' and ${inPeriod}`)} as repeat_views,
         ${count(pdf)} as pdf_downloads,
         ${count(`${pdf} and e.created_at >= now() - interval '7 days'`)} as pdf_last_7_days,
         ${count(`${pdf} and e.created_at >= now() - interval '30 days'`)} as pdf_last_30_days,
         ${count(`${pdf} and ${inPeriod}`)} as pdf_period,
         ${distinct(pdf)} as unique_downloaders,
         max(e.created_at) filter (where ${pdf}) as last_pdf_at,
         min(e.created_at) filter (where ${pdf}) as first_pdf_at,
         ${count(excel)} as excel_downloads,
         ${count(`${excel} and e.created_at >= now() - interval '7 days'`)} as excel_last_7_days,
         ${count(`${excel} and e.created_at >= now() - interval '30 days'`)} as excel_last_30_days,
         ${count(`${excel} and ${inPeriod}`)} as excel_period,
         ${distinct(excel)} as unique_excel_downloaders,
         max(e.created_at) filter (where ${excel}) as last_excel_at,
         ${count(request)} as requests_sent,
         ${count(`${request} and ${inPeriod}`)} as requests_period,
         max(e.created_at) filter (where ${request}) as last_request_at,
         min(e.created_at) filter (where ${request}) as first_request_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id and e.actor_type = 'client'
         and e.event_type in ('public_price_opened', 'public_price_reopened', 'public_price_pdf_downloaded', 'public_price_excel_downloaded', 'public_price_request_sent')
     ) client_events on true`;
}
