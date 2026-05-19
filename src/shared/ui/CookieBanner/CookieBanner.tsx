'use client';

import { useEffect, useState } from 'react';
import styles from './CookieBanner.module.scss';
import Button from '@/shared/ui/Button/Button';

type Consent = 'accepted' | 'declined';
type ConsentState = Consent | null | 'checking';

const CONSENT_KEY = 'cookieConsent';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function normalizeConsent(value: string | null | undefined): Consent | null {
  return value === 'accepted' || value === 'declined' ? value : null;
}

function readConsentCookie(): Consent | null {
  if (typeof document === 'undefined') return null;

  const rawValue = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${CONSENT_KEY}=`))
    ?.split('=')
    .slice(1)
    .join('=');

  if (!rawValue) return null;

  try {
    return normalizeConsent(decodeURIComponent(rawValue));
  } catch {
    return null;
  }
}

function writeConsentCookie(value: Consent) {
  if (typeof document === 'undefined') return;

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${CONSENT_KEY}=${encodeURIComponent(
    value,
  )}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function readStoredConsent(): Consent | null {
  const cookieConsent = readConsentCookie();
  if (cookieConsent) return cookieConsent;

  try {
    return normalizeConsent(window.localStorage.getItem(CONSENT_KEY));
  } catch {
    return null;
  }
}

function writeStoredConsent(value: Consent) {
  writeConsentCookie(value);

  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Keep the banner state usable even if storage is unavailable.
  }
}

export default function CookieBanner() {
  const [consent, setConsent] = useState<ConsentState>('checking');

  useEffect(() => {
    setConsent(readStoredConsent());
  }, []);

  const handleAccept = () => {
    writeStoredConsent('accepted');
    setConsent('accepted');
  };

  const handleDecline = () => {
    writeStoredConsent('declined');
    setConsent('declined');
  };

  if (consent === 'checking' || consent !== null) return null;

  return (
    <div className={styles.banner} role="dialog" aria-live="polite" aria-label="Cookies">
      <div className={styles.content}>
        <p className={styles.text}>Мы используем cookies для корректной работы сайта.</p>
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
