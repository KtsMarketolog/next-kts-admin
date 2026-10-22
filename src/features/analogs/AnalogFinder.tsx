'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

import { employeeRequest } from '@/features/admin/shared/employeeRequest';

import type { AnalogResult, AnalogSearchResponse } from '@/shared/lib/analogs';

import styles from './AnalogFinder.module.scss';
import { AnalogCatalogAvailability, type AnalogCatalogStock } from './AnalogCatalogAvailability';
import { SanhuaSelector } from './SanhuaSelector';

type AnalogResultWithStock = AnalogResult & { stock: AnalogCatalogStock | null; catalogMatches: AnalogCatalogStock[] };
type SearchPayload = Omit<AnalogSearchResponse, 'results'> & {
  results: AnalogResultWithStock[];
  knowledgeBase?: {
    generatedAt: string;
    stats: { directGroups: number; compressorItems: number };
  };
};

function formatCapacity(value: number | null) {
  if (value === null) return '';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
}

function capacityDifferenceLabel(value: number | null) {
  if (value === null) return '';
  if (Math.abs(value) < 0.05) return 'Холодопроизводительность совпадает';
  const sign = value > 0 ? '+' : '−';
  return `Холодопроизводительность ${sign}${Math.abs(value).toFixed(1).replace('.', ',')}%`;
}

export function AnalogFinder() {
  const [mode, setMode] = useState<'search' | 'sanhua'>('search');
  const [query, setQuery] = useState('');
  const [refrigerant, setRefrigerant] = useState('');
  const [sourceBrand, setSourceBrand] = useState('');
  const [payload, setPayload] = useState<SearchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  const runSearch = async (nextRefrigerant = refrigerant, nextQuery = query, nextBrand = sourceBrand) => {
    const cleanQuery = nextQuery.trim();
    if (cleanQuery.length < 2) {
      setError('Введите модель, артикул или название — минимум 2 символа');
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: cleanQuery });
      if (nextRefrigerant) params.set('refrigerant', nextRefrigerant);
      if (nextBrand) params.set('sourceBrand', nextBrand);
      const data = await employeeRequest<SearchPayload>(`/api/analogs/search?${params.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!data || !Array.isArray(data.results)) throw new Error('Не удалось выполнить поиск');
      setPayload(data);
    } catch (searchError) {
      if (controller.signal.aborted) return;
      setPayload(null);
      setError(searchError instanceof Error && searchError.message !== 'Unauthorized' ? searchError.message : 'Не удалось выполнить поиск');
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRefrigerant('');
    setSourceBrand('');
    void runSearch('', query, '');
  };

  const chooseRefrigerant = (value: string) => {
    setRefrigerant(value);
    void runSearch(value);
  };

  const chooseModel = (value: string, brand = '') => {
    setMode('search');
    setQuery(value);
    setRefrigerant('');
    setSourceBrand(brand);
    void runSearch('', value, brand);
  };

  const matchedModels = [...new Map((payload?.matches ?? []).map((match) => [
    `${match.brand}:${match.model}`, match,
  ])).values()];

  return (
    <section className={styles.finder}>
      <div className={styles.modeTabs} role="group" aria-label="Способ подбора">
        <button type="button" aria-pressed={mode === 'search'} onClick={() => setMode('search')}>Поиск аналогов</button>
        <button type="button" aria-pressed={mode === 'sanhua'} onClick={() => setMode('sanhua')}>Подбор Sanhua</button>
      </div>
      {mode === 'sanhua' ? <SanhuaSelector onChooseModel={(model) => chooseModel(model, 'Sanhua')} /> : <>
      <div className={styles.searchHero}>
        <span className={styles.eyebrow}>База знаний КТС</span>
        <h3>Подобрать аналог</h3>
        <p>Введите модель, артикул или название, в том числе конкурента. В результатах — только товары действующего каталога КТС, включая позиции без остатка.</p>
        <form className={styles.searchForm} onSubmit={submit}>
          <label>
            <span className={styles.visuallyHidden}>Модель, артикул или название оборудования</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Например, YWF.A4S-350S-5DIA00 или ZP42KSE-TFD"
              autoComplete="off"
            />
          </label>
          <button disabled={loading} type="submit">
            {loading ? 'Ищем…' : 'Найти аналоги'}
          </button>
        </form>
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>

      {payload?.matches.length && !payload.requiresModelSelection ? (
        <div>
        <div className={styles.matchSummary}>
          <span>Найдена исходная позиция</span>
          <strong>{matchedModels.map((match) => `${match.brand} ${match.model}`).join(' · ')}</strong>
        </div>
        {payload.matches.some((match) => match.technicalSpecifications?.length || match.note) ? <details className={styles.sourceDetails}>
          <summary>Характеристики и условия исходной модели</summary>
          {payload.matches.map((match, index) => <div key={`${match.brand}:${match.model}:${index}`}>
            <strong>{match.brand} {match.model}</strong>
            {match.technicalSpecifications?.length ? <dl className={styles.capacityGrid}>
              {match.technicalSpecifications.map((spec, i) => <div key={i}><dt>{spec.label}</dt><dd>{spec.value} {spec.unit}</dd></div>)}
            </dl> : null}
            {match.note ? <p>{match.note}</p> : null}
            <small>{match.sourceFileName}{match.sourceSheet ? ` · ${match.sourceSheet}` : ''}{match.sourceRow ? ` · строка ${match.sourceRow}` : ''}</small>
          </div>)}
        </details> : null}
        </div>
      ) : null}

      {payload?.requiresModelSelection ? (
        <section className={styles.refrigerantPrompt} aria-labelledby="analog-model-title">
          <div>
            <span>Нужно уточнение</span>
            <h4 id="analog-model-title">Выберите модификацию</h4>
            <p>Запрос подходит к нескольким исходным моделям. Их аналоги не смешиваются — выберите нужную модификацию.</p>
          </div>
          <div className={styles.refrigerantButtons}>
            {matchedModels.map((match) => (
              <button
                key={`${match.brand}:${match.model}`}
                type="button"
                onClick={() => chooseModel(match.model, match.brand)}
                disabled={loading}
              >
                {match.brand} {match.model}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {payload?.requiresRefrigerant && !payload.requiresModelSelection ? (
        <section className={styles.refrigerantPrompt} aria-labelledby="analog-refrigerant-title">
          <div>
            <span>Нужно уточнение</span>
            <h4 id="analog-refrigerant-title">Выберите хладагент</h4>
            <p>Эта модель встречается в нескольких режимах. Без хладагента сравнение холодопроизводительности будет некорректным.</p>
          </div>
          <div className={styles.refrigerantButtons}>
            {payload.availableRefrigerants.map((value) => (
              <button key={value} type="button" onClick={() => chooseRefrigerant(value)} disabled={loading}>
                {value}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {!payload?.requiresModelSelection && payload?.notices.map((notice) => (
        <div className={styles.sourceNotice} key={notice}>
          <strong>Важно по источнику</strong>
          <p>{notice}</p>
        </div>
      ))}

      {payload && !payload.requiresModelSelection && !payload.requiresRefrigerant ? (
        <section className={styles.results} aria-live="polite">
          <div className={styles.resultsHeader}>
            <div>
              <span>Результаты</span>
              <h4>{payload.total > 0 ? `Найдено: ${payload.total}` : 'Аналоги не найдены'}</h4>
            </div>
            {payload.refrigerant ? <strong>{payload.refrigerant}</strong> : null}
          </div>

          {payload.results.length === 0 ? (
            <div className={styles.emptyResult}>
              <h5>Нет подтверждённого аналога в действующем каталоге</h5>
              <p>Проверьте модель и модификацию. Если связь отсутствует или товар не удалось однозначно сопоставить с каталогом, требуется проверка техспециалиста. Это не означает нулевой остаток.</p>
            </div>
          ) : (
            <div className={styles.resultGrid}>
              {payload.results.map((result) => (
                <article className={result.sourceFlagged ? styles.resultCardFlagged : styles.resultCard} key={result.id}>
                  <div className={styles.resultTopline}>
                    <span>{result.brand}</span>
                    <span className={styles.stockAvailable}>В каталоге КТС</span>
                  </div>
                  <h5>{result.model}</h5>
                  <p className={styles.category}>{result.category}</p>
                  {result.matchType === 'capacity' ? (
                    <dl className={styles.capacityGrid}>
                      <div>
                        <dt>Холодопроизводительность</dt>
                        <dd>{formatCapacity(result.coolingCapacityKw)} кВт</dd>
                      </div>
                      <div>
                        <dt>Отличие от исходной</dt>
                        <dd>{capacityDifferenceLabel(result.capacityDifferencePercent)}</dd>
                      </div>
                    </dl>
                  ) : null}
                  {result.application ? <p className={styles.application}>{result.application}</p> : null}
                  {result.technicalSpecifications?.length ? <dl className={styles.capacityGrid}>
                    {result.technicalSpecifications.map((spec, index) => <div key={index}>
                      <dt>{spec.label}</dt><dd>{spec.value} {spec.unit}</dd>
                    </div>)}
                  </dl> : null}
                  <AnalogCatalogAvailability items={result.catalogMatches ?? (result.stock ? [result.stock] : [])} />
                  {result.sourceFlagged ? (
                    <p className={styles.qualityWarning}>В исходной таблице позиция помечена для дополнительной проверки по datasheet.</p>
                  ) : null}
                  <footer>
                    <strong>{result.sourceLabel}</strong>
                    <span>
                      {result.sourceFileName}
                      {result.sourceSheet ? ` · ${result.sourceSheet}` : ''} · строка {result.sourceRow}
                    </span>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}
      </>}
    </section>
  );
}
