'use client';

import { FormEvent, useState } from 'react';

import type { AnalogResult, AnalogSearchResponse } from '@/shared/lib/analogs';

import styles from './AnalogFinder.module.scss';

type AnalogStock = {
  productId: number;
  title: string;
  sku: string;
  model: string;
  stock: number;
  stockVolzhsk: number;
  stockMoscow: number;
  unit: string;
  isExpected: boolean;
};

type AnalogResultWithStock = AnalogResult & { stock: AnalogStock | null };
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

function StockBadge({ stock }: { stock: AnalogStock | null }) {
  if (!stock) return <span className={styles.stockUnknown}>Нет совпадения в текущем каталоге</span>;
  if (stock.stock > 0) {
    return (
      <span className={styles.stockAvailable}>
        В наличии: {stock.stock} {stock.unit}
      </span>
    );
  }
  if (stock.isExpected) return <span className={styles.stockExpected}>Ожидается поступление</span>;
  return <span className={styles.stockOrder}>Под заказ</span>;
}

export function AnalogFinder() {
  const [query, setQuery] = useState('');
  const [refrigerant, setRefrigerant] = useState('');
  const [payload, setPayload] = useState<SearchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runSearch = async (nextRefrigerant = refrigerant, nextQuery = query) => {
    const cleanQuery = nextQuery.trim();
    if (cleanQuery.length < 2) {
      setError('Введите модель, артикул или название — минимум 2 символа');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: cleanQuery });
      if (nextRefrigerant) params.set('refrigerant', nextRefrigerant);
      const response = await fetch(`/api/analogs/search?${params.toString()}`, { cache: 'no-store' });
      const data = (await response.json().catch(() => null)) as SearchPayload | { error?: string } | null;
      if (!response.ok || !data || !('results' in data)) {
        throw new Error(data && 'error' in data && data.error ? data.error : 'Не удалось выполнить поиск');
      }
      setPayload(data);
    } catch (searchError) {
      setPayload(null);
      setError(searchError instanceof Error && searchError.message !== 'Unauthorized' ? searchError.message : 'Не удалось выполнить поиск');
    } finally {
      setLoading(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRefrigerant('');
    void runSearch('');
  };

  const chooseRefrigerant = (value: string) => {
    setRefrigerant(value);
    void runSearch(value);
  };

  const chooseModel = (value: string) => {
    setQuery(value);
    setRefrigerant('');
    void runSearch('', value);
  };

  return (
    <section className={styles.finder}>
      <div className={styles.searchHero}>
        <span className={styles.eyebrow}>База знаний КТС</span>
        <h3>Подобрать аналог</h3>
        <p>Введите модель, артикул или название оборудования.</p>
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
        <div className={styles.matchSummary}>
          <span>Найдена исходная позиция</span>
          <strong>{payload.matches.map((match) => `${match.brand} ${match.model}`).join(' · ')}</strong>
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
            {payload.matches.map((match) => (
              <button
                key={`${match.brand}:${match.model}:${match.refrigerant ?? ''}:${match.application ?? ''}`}
                type="button"
                onClick={() => chooseModel(match.model)}
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
              <h5>В базе пока нет подходящей связи</h5>
              <p>Проверьте написание модели без лишнего описания. Если модель указана верно, передайте запрос менеджеру.</p>
            </div>
          ) : (
            <div className={styles.resultGrid}>
              {payload.results.map((result) => (
                <article className={result.sourceFlagged ? styles.resultCardFlagged : styles.resultCard} key={result.id}>
                  <div className={styles.resultTopline}>
                    <span>{result.brand}</span>
                    <StockBadge stock={result.stock} />
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
    </section>
  );
}
