'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CurrencyDashboard } from '@/features/admin/currency-dashboard/CurrencyDashboard';
import { SharedDashboardFrame } from '@/features/admin/manager-dashboard/ManagerDashboardParts';
import { useTopDashboardDownloadBridge } from '@/features/admin/top-dashboard/useTopDashboardDownloadBridge';
import { DashboardDataDates } from '@/features/admin/top-dashboard/DashboardDataDates';
import { useDashboardUsage } from '@/features/admin/dashboard-usage/useDashboardUsage';
import type { DashboardPairConfig, DashboardPairOverview, DashboardPairPanel } from '@/shared/lib/dashboardPair';
import styles from './DashboardPair.module.scss';

export function DashboardPair() {
  const [overview, setOverview] = useState<DashboardPairOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [layoutOverride, setLayoutOverride] = useState<DashboardPairConfig['layout'] | null>(null);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const response = await fetch('/api/admin/dashboard-pair', {cache:'no-store', credentials:'same-origin'});
      const result = await response.json();
      if (requestId.current !== id) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setOverview(null);
        throw new Error(result.error || 'Не удалось открыть отчёты');
      }
      setOverview(result);
      setError('');
    } catch (cause) {
      if (requestId.current === id) setError(cause instanceof Error ? cause.message : 'Не удалось открыть отчёты');
    }
  }, []);
  useEffect(() => {
    void load();
    const visibleReload = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(visibleReload, 60_000);
    window.addEventListener('focus', visibleReload);
    document.addEventListener('visibilitychange', visibleReload);
    return () => {
      requestId.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('focus', visibleReload);
      document.removeEventListener('visibilitychange', visibleReload);
    };
  }, [load]);

  async function save(config: DashboardPairConfig) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/dashboard-pair', {
        method:'PUT', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить настройку');
      setLayoutOverride(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить настройку'); }
    finally { setBusy(false); }
  }
  const layout = layoutOverride ?? overview?.layout ?? 'columns';
  return <main className={styles.root}>
    <header className={styles.header}>
      <div><h1>Два отчёта</h1><p>Фиксированная пара. Доступ к каждому отчёту проверяется отдельно.</p></div>
      <nav aria-label="Управление парным экраном">
        <Link href="/admin/top">К списку отчётов</Link>
        <button type="button" onClick={() => void load()}>Обновить</button>
        <button type="button" aria-pressed={layout === 'columns'} onClick={() => setLayoutOverride('columns')}>Рядом</button>
        <button type="button" aria-pressed={layout === 'rows'} onClick={() => setLayoutOverride('rows')}>Друг под другом</button>
      </nav>
    </header>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!overview && !error ? <p role="status">Загружаем отчёты…</p> : null}
    {overview?.configured ? <div className={styles.panels} data-layout={layout}>
      {overview.panels.map((panel) => <section key={panel.key} className={styles.panel}>
        <h2>{panel.title}</h2>
        {panel.available ? <PairReport panel={panel} /> : <p>{panel.message}</p>}
      </section>)}
    </div> : overview ? <section className={styles.panel}>
      <h2>Пара отчётов ещё не назначена</h2><p>После согласования администратор выберет два отчёта для этого экрана. Сейчас ни один отчёт не выбран автоматически.</p>
    </section> : null}
    {overview?.canConfigure ? <PairSettings key={overview.revision} overview={overview} busy={busy} save={save} /> : null}
  </main>;
}

function PairSettings({overview, busy, save}: {overview:DashboardPairOverview; busy:boolean; save:(config:DashboardPairConfig) => Promise<void>}) {
  const [first, setFirst] = useState(overview.settings?.keys[0] ?? '');
  const [second, setSecond] = useState(overview.settings?.keys[1] ?? '');
  const [layout, setLayout] = useState<DashboardPairConfig['layout']>(overview.layout);
  return <details className={styles.settings} open={!overview.configured}>
    <summary>Настройка пары — только для администратора</summary>
    <p>Выберите согласованную пару общих отчётов. Настройка не выдаёт сотрудникам новых прав.</p>
    <form onSubmit={(event) => {event.preventDefault(); void save({keys:[first,second], layout, revision:overview.revision});}}>
      {([['Первый отчёт', first, setFirst], ['Второй отчёт', second, setSecond]] as const).map(([label, value, change]) => <label key={label}>
        {label}<select aria-label={label} required value={value} onChange={(event) => change(event.target.value)} disabled={busy}>
          <option value="">Не выбран</option>
          {overview.options?.map((item) => <option key={item.key} value={item.key}>{item.title}</option>)}
        </select>
      </label>)}
      <label>Начальное расположение<select value={layout} disabled={busy} onChange={(event) => setLayout(event.target.value as DashboardPairConfig['layout'])}>
        <option value="columns">Рядом</option><option value="rows">Друг под другом</option>
      </select></label>
      <button type="submit" disabled={busy || !first || !second || first === second}>{busy ? 'Сохраняем…' : 'Сохранить фиксированную пару'}</button>
    </form>
  </details>;
}

function PairReport({panel}: {panel:DashboardPairPanel}) {
  const [nonce] = useState(() => globalThis.crypto.randomUUID());
  if (panel.kind === 'currency') return <CurrencyDashboard nonce={nonce} canManage={false} embedded />;
  if (panel.kind === 'route-planner' && panel.versionId) return <SharedDashboardFrame versionId={panel.versionId} snapshotId={panel.snapshotId} />;
  if (panel.kind === 'top' && panel.versionId) return <PairTopReport panel={panel} />;
  return <p>Отчёт пока не опубликован.</p>;
}

function PairTopReport({panel}: {panel:DashboardPairPanel}) {
  const [status, setStatus] = useState('');
  const frame = useTopDashboardDownloadBridge(setStatus);
  useDashboardUsage({dashboardKey:panel.key, iframeRef:frame, versionId:panel.versionId});
  return <>
    <p className={styles.dates}><DashboardDataDates uploadedAt={panel.dataUploadedAt} dataAsOf={panel.dataAsOf} /></p>
    {status ? <p role="status">{status}</p> : null}
    <iframe ref={frame} title={panel.title} className={styles.frame}
      key={`${panel.key}:${panel.versionId}:${panel.reportRevision ?? ''}`}
      src={`/api/admin/top-dashboard/blocks/${panel.key.slice(4)}/versions/${panel.versionId}/frame`}
      sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen *" allowFullScreen />
  </>;
}
