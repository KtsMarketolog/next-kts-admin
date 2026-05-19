'use client';

import { useEffect, useState } from 'react';
import styles from './CookieBanner.module.scss';
import Button from '@/shared/ui/Button/Button';

type Consent = 'accepted' | 'declined';
type ConsentState = Consent | null | 'checking';

export default function CookieBanner() {

  const [consent, setConsent] = useState<ConsentState>('checking');

  useEffect(() => {

    try {

      const stored = localStorage.getItem('cookieConsent');

      setConsent(stored === 'accepted' || stored === 'declined' ? stored : null);

    } catch {

      setConsent(null);

    }

  }, []);

  const handleAccept = () => {

    try {

      localStorage.setItem('cookieConsent', 'accepted');

    } catch {

      // Keep the banner state usable even if storage is unavailable.

    }

    setConsent('accepted');

  };

  const handleDecline = () => {

    try {

      localStorage.setItem('cookieConsent', 'declined');

    } catch {

      // Keep the banner state usable even if storage is unavailable.

    }

    setConsent('declined');

  };

  if (consent === 'checking' || consent !== null) return null;

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
