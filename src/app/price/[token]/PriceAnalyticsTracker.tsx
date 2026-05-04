'use client';

import { useEffect } from 'react';

type PriceAnalyticsTrackerProps = {
  token: string;
};

export function PriceAnalyticsTracker({ token }: PriceAnalyticsTrackerProps) {
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/price/${token}/view`, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
    }).catch(() => {
      // Analytics must not block the public price page.
    });

    return () => controller.abort();
  }, [token]);

  return null;
}
