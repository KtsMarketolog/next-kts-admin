// src/components/layout/ConditionalFooter.tsx
'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';

import { FooterSkeleton } from './Footer/FooterSkeleton';

const Footer = dynamic(() => import('../layout/Footer/Footer').then((mod) => mod.Footer), {
  ssr: false,
  loading: () => <FooterSkeleton />,
});

export const ConditionalFooter = () => {

  const pathname = usePathname();
  const hideOnContacts = pathname === '/contacts';

  if (hideOnContacts) return null;

  return <Footer />;

};
