// src/components/layout/ConditionalFooter.tsx
'use client';

import { usePathname } from 'next/navigation';
import { Footer } from '../layout/Footer/Footer';

export const ConditionalFooter = () => {

  const pathname = usePathname();
  const hideOnContacts = pathname === '/contacts';

  if (hideOnContacts) return null;

  return <Footer />;

};