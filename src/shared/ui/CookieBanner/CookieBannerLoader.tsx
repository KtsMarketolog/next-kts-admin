'use client';

import dynamic from 'next/dynamic';

const CookieBanner = dynamic(() => import('./CookieBanner'), {
  loading: () => null,
  ssr: false,
});

export default function CookieBannerLoader() {
  return <CookieBanner />;
}
