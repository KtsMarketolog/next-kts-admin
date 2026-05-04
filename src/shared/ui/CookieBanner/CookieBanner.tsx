'use client';

import { useEffect, useState } from 'react';
import styles from './CookieBanner.module.scss';
import Button from '@/shared/ui/Button/Button';

type Consent = 'accepted' | 'declined' | null;

export default function CookieBanner() {

  const [consent, setConsent] = useState<Consent>(null);

  useEffect(() => {

    const stored = localStorage.getItem('cookieConsent') as Consent;

    if (stored) setConsent(stored);

  }, []);

  const handleAccept = () => {

    localStorage.setItem('cookieConsent', 'accepted');
    setConsent('accepted');

  };

  const handleDecline = () => {

    localStorage.setItem('cookieConsent', 'declined');
    setConsent('declined');

  };

  if (consent !== null) return null;

  return (

    <div className={styles.banner} role="dialog" aria-live="polite" aria-label="Cookies">

      <div className={styles.content}>

        <p className={styles.text}>

          Мы используем cookies для корректной работы сайта.

        </p>
        
      </div>

      <div className={styles.actions}>

        <Button type="button" variant="primary" withBg onClick={handleAccept}>

          Принять

        </Button>

        <Button type="button" variant="primary" onClick={handleDecline}>

          Отклонить

        </Button>

      </div>

    </div>

  );

}