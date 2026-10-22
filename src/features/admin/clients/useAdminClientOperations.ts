'use client';

import { useCallback, useRef, useState } from 'react';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';

/** All client writes and reads share one cancellation and stale-response fence. */
export function useAdminClientOperations() {
  const { request, cancelAll, isActive } = useAdminRequestScope();
  const mutationRef = useRef(false);
  const dataGeneration = useRef(0);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const showStatus = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 2200);
  }, []);

  const startMutation = () => {
    if (mutationRef.current) return false;
    mutationRef.current = true;
    dataGeneration.current += 1;
    setBusy(true);
    return true;
  };

  const finishMutation = () => {
    dataGeneration.current += 1;
    mutationRef.current = false;
    setBusy(false);
  };


  return { request, cancelAll, isActive, mutationRef, dataGeneration, status, setStatus, busy, setBusy, showStatus, startMutation, finishMutation };
}

export type AdminClientOperations = ReturnType<typeof useAdminClientOperations>;
