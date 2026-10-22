export type AnalyticsChangeRow = {
  id: string;
  price_id: string | null;
  price_title: string;
  action: string;
  changed_by: string | null;
  created_at: string;
  details: string | null;
};

export type AnalyticsProblemRow = {
  id: string;
  title: string;
  client_name: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  item_count: string;
  views: string;
  pdf_downloads: string;
};

export type AnalyticsSummaryRow = {
  total_prices: string;
  active_prices: string;
  expired_prices: string;
  expiring_soon_7_days: string;
  expiring_soon_30_days: string;
  prices_last_7_days: string;
  prices_last_30_days: string;
  period_prices: string;
  average_items_per_price: string | null;
  median_items_per_price: string | null;
  empty_prices: string;
  prices_without_client: string;
  prices_without_expiration: string;
  stale_prices_30_days: string;
  prices_without_views: string;
  disabled_prices: string;
  prices_without_pdf_downloads: string;
};

export type AnalyticsEventRow = {
  id: string;
  event_type: string;
  actor_type: string;
  price_id: string | null;
  price_title: string | null;
  client_id: string | null;
  client_name: string | null;
  manager_name: string | null;
  created_at: string;
  details: string | null;
  session_id: string | null;
  referer: string | null;
};

export type AnalyticsWorkflowRow = {
  id: string;
  title: string;
  client_name: string;
  workflow_status?: string | null;
  valid_until: string | null;
  is_active: boolean;
  manager_id?: string | null;
  manager_name?: string | null;
  created_at: string;
  updated_at: string;
  views: string;
  views_last_7_days: string;
  repeat_views: string;
  pdf_downloads: string;
  requests_sent: string;
  last_view_at: string | null;
  last_pdf_at: string | null;
  last_request_at: string | null;
  first_view_at?: string | null;
  first_pdf_at?: string | null;
  first_request_at?: string | null;
  last_manager_activity_at?: string | null;
  last_client_event_type?: string | null;
};
