'use client';

import type { ReactNode } from 'react';

type PriceEventLinkProps = {
  href: string;
  token: string;
  eventType: 'public_price_phone_clicked' | 'public_price_email_clicked';
  children: ReactNode;
};

function trackPriceEvent(token: string, eventType: PriceEventLinkProps['eventType']) {
  fetch(`/api/price/${encodeURIComponent(token)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType, metadata: { source: 'manager_contact' } }),
    keepalive: true,
  }).catch(() => {
    // Analytics must not block the contact action.
  });
}

export function PriceEventLink({ href, token, eventType, children }: PriceEventLinkProps) {
  return (
    <a href={href} onClick={() => trackPriceEvent(token, eventType)}>
      {children}
    </a>
  );
}
