'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { normalizeTopDashboardDataContract, readError, type TopDashboardOverview } from './topDashboardManagementModel';

/** Shared request lifetime and mutation lock; each operation keeps its own selection/draft. */
export function useTopDashboardManagement(blockId: number, previewFrameRef: RefObject<HTMLIFrameElement | null>, showStatus: (message: string) => void) {
  const router = useRouter();
  const [overview, setOverview] = useState<TopDashboardOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const showStatusRef = useRef(showStatus);
  const overviewRequestIdRef = useRef(0);
  const mutationRef = useRef(false);
  const { request, cancelAll, isActive } = useAdminRequestScope();
  const beginMutation = (action: string) => {
    if (mutationRef.current) return false;
    mutationRef.current = true;
    setBusyAction(action);
    return true;
  };
  const finishMutation = () => { mutationRef.current = false; setBusyAction(null); };
  const apiBasePath = `/api/admin/top-dashboard/blocks/${blockId}`;

  useEffect(() => { showStatusRef.current = showStatus; }, [showStatus]);

  const loadOverview = useCallback(async (preferredVersionId?: number | null) => {
    const requestId = overviewRequestIdRef.current + 1;
    overviewRequestIdRef.current = requestId;
    setLoading(true);
    try {
      const response = await request(apiBasePath, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось загрузить версии HTML-страницы');
        if (requestId !== overviewRequestIdRef.current) return null;
        setLoadError(message);
        showStatusRef.current(message);
        return null;
      }

      const data = (await response.json()) as TopDashboardOverview;
      if (requestId !== overviewRequestIdRef.current) return null;
      if (!requestProfitabilityFrameChange(previewFrameRef.current, false)) return null;
      const versions = Array.isArray(data.versions) ? data.versions : [];
      const normalized: TopDashboardOverview = {
        block: data.block,
        activeVersionId: Number.isInteger(data.activeVersionId) ? data.activeVersionId : null,
        previousVersionId: Number.isInteger(data.previousVersionId) ? data.previousVersionId : null,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        versions,
        data: {
          activeVersionId: Number.isInteger(data.data?.activeVersionId) ? data.data.activeVersionId : null,
          previousVersionId: Number.isInteger(data.data?.previousVersionId) ? data.data.previousVersionId : null,
          updatedAt: typeof data.data?.updatedAt === 'string' ? data.data.updatedAt : null,
          versions: Array.isArray(data.data?.versions) ? data.data.versions : [],
        },
        activeDataContract: normalizeTopDashboardDataContract(data.activeDataContract),
        instruction: data.instruction === 'sales-analytics' || data.instruction === 'deal-profitability' ? data.instruction : null,
      };
      setLoadError(null);
      setOverview(normalized);
      setSelectedVersionId((current) => {
        const requested = preferredVersionId ?? current;
        if (requested && versions.some((version) => version.id === requested)) return requested;
        if (normalized.activeVersionId && versions.some((version) => version.id === normalized.activeVersionId)) {
          return normalized.activeVersionId;
        }
        return versions[0]?.id ?? null;
      });
      return normalized;
    } catch (error) {
      if (requestId !== overviewRequestIdRef.current) return null;
      const message = error instanceof Error ? error.message : 'Не удалось загрузить версии HTML-страницы';
      setLoadError(message);
      showStatusRef.current(message);
      return null;
    } finally {
      if (requestId === overviewRequestIdRef.current) setLoading(false);
    }
  }, [apiBasePath, request, previewFrameRef]);

  useEffect(() => {
    void loadOverview();
    return () => { overviewRequestIdRef.current += 1; cancelAll(); };
  }, [loadOverview, cancelAll]);

  useEffect(() => {
    const refreshVisibleOverview = () => {
      if (document.visibilityState === 'visible' && !mutationRef.current) void loadOverview();
    };

    window.addEventListener('focus', refreshVisibleOverview);
    document.addEventListener('visibilitychange', refreshVisibleOverview);
    return () => {
      window.removeEventListener('focus', refreshVisibleOverview);
      document.removeEventListener('visibilitychange', refreshVisibleOverview);
    };
  }, [loadOverview]);

  return { blockId, router, previewFrameRef, overview, setOverview, loadError, selectedVersionId, setSelectedVersionId, loading, busyAction, previewRevision, setPreviewRevision, showStatusRef, mutationRef, request, cancelAll, isActive, beginMutation, finishMutation, apiBasePath, loadOverview };
}

export type TopDashboardManagement = ReturnType<typeof useTopDashboardManagement>;
