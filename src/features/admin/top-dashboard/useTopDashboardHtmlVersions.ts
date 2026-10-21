'use client';

import { useEffect, useRef, useState } from 'react';
import { ADMIN_UPLOAD_TIMEOUT_MS } from '@/features/admin/shared/adminRequest';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { TOP_DASHBOARD_HTML_MAX_BYTES as MAX_HTML_BYTES, TOP_DASHBOARD_HTML_MAX_MEGABYTES } from '@/shared/lib/topDashboardLimits';
import { defaultTopDashboardIntegrationMode, readError, type TopDashboardIntegrationMode, type TopDashboardVersion, type UploadFeedback } from './topDashboardManagementModel';
import type { TopDashboardManagement } from './useTopDashboardManagement';

/** HTML selection, draft upload, publication and deletion share no data-upload state. */
export function useTopDashboardHtmlVersions(management: TopDashboardManagement) {
  const { blockId, overview, mutationRef, previewFrameRef, beginMutation, finishMutation, request, apiBasePath, loadOverview, selectedVersionId, setPreviewRevision, showStatusRef, isActive } = management;
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [integrationSelection, setIntegrationSelection] = useState<{ blockId: number; mode: TopDashboardIntegrationMode } | null>(null);
  const integrationMode = integrationSelection?.blockId === blockId
    ? integrationSelection.mode : defaultTopDashboardIntegrationMode(overview);
  const chooseIntegrationMode = (mode: TopDashboardIntegrationMode) => {
    setIntegrationSelection({ blockId, mode });
    setHtmlUploadFeedback(null);
  };
  const [htmlUploadFeedback, setHtmlUploadFeedback] = useState<UploadFeedback | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reportUploadFeedback = (_target: 'html', message: string, kind: UploadFeedback['kind'] = 'error') => {
    setHtmlUploadFeedback({ kind, message });
    showStatusRef.current(message);
  };
  useEffect(() => { setHtmlUploadFeedback(null); }, [loadOverview]);

  const chooseFile = (file: File | null) => {
    setHtmlUploadFeedback(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!/\.html?$/i.test(file.name)) {
      setSelectedFile(null);
      reportUploadFeedback('html', 'Выберите файл с расширением .html или .htm');
      return;
    }
    if (file.size <= 0 || file.size > MAX_HTML_BYTES) {
      setSelectedFile(null);
      reportUploadFeedback('html', `HTML-файл должен быть непустым и не больше ${TOP_DASHBOARD_HTML_MAX_MEGABYTES} МБ`);
      return;
    }
    // A background overview refresh must not change the mode of an already selected file.
    setIntegrationSelection((current) => current?.blockId === blockId ? current : { blockId, mode: integrationMode });
    setSelectedFile(file);
  };

  const uploadVersion = async () => {
    if (mutationRef.current) return;
    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
    setHtmlUploadFeedback(null);
    if (!selectedFile) {
      reportUploadFeedback('html', 'Сначала выберите HTML-файл');
      return;
    }

    if (!beginMutation('upload')) return;
    try {
      const body = new FormData();
      body.set('file', selectedFile);
      body.set('integrationMode', integrationMode);
      const response = await request(`${apiBasePath}/versions`, {
        method: 'POST',
        body,
        credentials: 'same-origin',
      }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });
      if (!response.ok) {
        reportUploadFeedback('html', await readError(response, 'Не удалось загрузить HTML-файл'));
        return;
      }

      const data = await response.json().catch(() => ({}));
      const versionId = Number(data.version?.id);
      if (!Number.isSafeInteger(versionId) || versionId <= 0) {
        reportUploadFeedback('html', 'Сервер не подтвердил номер новой HTML-версии. Проверьте историю перед повторной загрузкой.');
        return;
      }
      const savedName = typeof data.version?.originalName === 'string' ? data.version.originalName : selectedFile.name;
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      const refreshed = await loadOverview(versionId);
      setPreviewRevision((current) => current + 1);
      reportUploadFeedback('html', `HTML «${savedName}» сохранён как черновик #${versionId}. Текущая публикация не изменена.${refreshed ? '' : ' Список версий не обновился — обновите страницу.'}`, 'success');
    } catch (error) {
      if (isActive()) reportUploadFeedback('html', error instanceof Error ? error.message : 'Не удалось получить подтверждение загрузки HTML. Проверьте историю версий перед повторной попыткой.');
    } finally {
      finishMutation();
    }
  };

  const activateVersion = async (version: TopDashboardVersion) => {
    if (mutationRef.current) return;
    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
    if (!overview || version.status === 'active') return;
    if (
      version.status === 'archived'
      && !window.confirm(`Откатить опубликованную HTML-страницу на версию «${version.originalName}»?`)
    ) {
      return;
    }

    if (!beginMutation(`activate:${version.id}`)) return;
    try {
      const response = await request(`${apiBasePath}/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          versionId: version.id,
          expectedActiveVersionId: overview.activeVersionId,
        }),
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось опубликовать версию HTML');
        if (response.status === 409) await loadOverview(version.id);
        showStatusRef.current(message);
        return;
      }

      const data = await response.json().catch(() => ({}));
      const refreshed = await loadOverview(version.id);
      setPreviewRevision((current) => current + 1);
      const success = data.state?.change === 'rolled_back' ? 'Выполнен откат на выбранную версию' : 'Версия опубликована';
      showStatusRef.current(`${success}.${refreshed ? '' : ' Список не обновился — обновите страницу, повторять публикацию не нужно.'}`);
    } catch (error) {
      if (isActive()) showStatusRef.current(error instanceof Error ? error.message : 'Не удалось подтвердить публикацию. Обновите историю перед повторной попыткой.');
    } finally {
      finishMutation();
    }
  };

  const deleteVersion = async (version: TopDashboardVersion) => {
    if (mutationRef.current) return;
    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
    if (!overview || version.status === 'active') return;
    if (
      !window.confirm(
        `Удалить файл «${version.originalName}», версия #${version.id}?\n\nЭто действие необратимо: восстановить удалённую версию будет нельзя.`,
      )
    ) {
      return;
    }

    const remainingVersions = overview.versions.filter((item) => item.id !== version.id);
    const preferredVersionId = selectedVersionId === version.id
      ? remainingVersions.find((item) => item.id === overview.activeVersionId)?.id
        ?? remainingVersions[0]?.id
        ?? null
      : selectedVersionId;

    if (!beginMutation(`delete:${version.id}`)) return;
    try {
      const response = await request(`${apiBasePath}/versions/${version.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось удалить версию HTML');
        if (response.status === 404 || response.status === 409) {
          await loadOverview(preferredVersionId);
        }
        showStatusRef.current(message);
        return;
      }

      const refreshed = await loadOverview(preferredVersionId);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current(`Версия #${version.id} удалена.${refreshed ? '' : ' Список не обновился — обновите страницу, повторять удаление не нужно.'}`);
    } catch (error) {
      if (isActive()) showStatusRef.current(error instanceof Error ? error.message : 'Не удалось подтвердить удаление HTML. Обновите историю перед повторной попыткой.');
    } finally {
      finishMutation();
    }
  };

  return { selectedFile, integrationMode, chooseIntegrationMode, htmlUploadFeedback, fileInputRef, chooseFile, uploadVersion, activateVersion, deleteVersion };
}

export type TopDashboardHtmlVersions = ReturnType<typeof useTopDashboardHtmlVersions>;
