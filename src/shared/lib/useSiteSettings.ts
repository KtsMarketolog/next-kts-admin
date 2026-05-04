'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_PHONE } from './phone';

export function useSiteSettings() {
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [email, setEmail] = useState(DEFAULT_EMAIL);
  const [address, setAddress] = useState(DEFAULT_ADDRESS);

  useEffect(() => {
    let alive = true;

    fetch('/api/site-settings', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive && typeof data?.phone === 'string' && data.phone.trim()) {
          setPhone(data.phone.trim());
        }
        if (alive && typeof data?.email === 'string' && data.email.trim()) {
          setEmail(data.email.trim());
        }
        if (alive && typeof data?.address === 'string' && data.address.trim()) {
          setAddress(data.address.trim());
        }
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, []);

  return { phone, email, address };
}
