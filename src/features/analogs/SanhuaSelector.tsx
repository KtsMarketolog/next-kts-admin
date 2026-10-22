'use client';

import { useEffect, useId, useMemo, useState } from 'react';

import { adminRequest } from '@/features/admin/shared/adminRequest';
import {
  filterSanhuaCandidates,
  formatSanhuaSpecification,
  getSanhuaTableOptions,
  SANHUA_INCOMPLETE_BLOCKS,
  SANHUA_SELECTION_FAMILIES,
  type SanhuaFamilyId,
  type SanhuaSelectionCandidate,
} from '@/shared/lib/sanhuaSelection';

import { AnalogCatalogAvailability } from './AnalogCatalogAvailability';
import styles from './SanhuaSelector.module.scss';

type Props = { onChooseModel?: (model: string) => void };

export function SanhuaSelector({ onChooseModel }: Props) {
  const prefix = useId();
  const [candidates, setCandidates] = useState<SanhuaSelectionCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [familyId, setFamilyId] = useState<SanhuaFamilyId | ''>('');
  const [size, setSize] = useState('');
  const [execution, setExecution] = useState('');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(12);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await adminRequest('/api/analogs/sanhua', { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload?.candidates)) {
          throw new Error(payload?.error || 'Не удалось загрузить справочник Sanhua');
        }
        if (active) setCandidates(payload.candidates);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Не удалось загрузить справочник Sanhua');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [attempt]);

  const family = SANHUA_SELECTION_FAMILIES.find((entry) => entry.id === familyId);
  const options = useMemo(() => getSanhuaTableOptions(candidates, familyId), [candidates, familyId]);
  const results = useMemo(() => filterSanhuaCandidates(candidates, { familyId, size, execution, query }), [candidates, familyId, size, execution, query]);

  return (
    <section className={styles.selector} aria-labelledby={`${prefix}-title`}>
      <header>
        <span className={styles.eyebrow}>Подсказки по методике Sanhua</span>
        <h3 id={`${prefix}-title`}>От модели к проверке параметров</h3>
        <p>Показываем позиции нашего каталога, у которых в таблице явно указаны размер и соединение или исполнение. Это справочный фильтр, а не расчёт взаимозаменяемости.</p>
      </header>

      {loading ? <p role="status">Загружаем справочник…</p> : null}
      {error ? (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => { setLoading(true); setError(''); setAttempt((value) => value + 1); }}>Повторить загрузку</button>
        </div>
      ) : null}

      {!loading && !error ? (
        <>
          <div className={styles.steps}>
            <label htmlFor={`${prefix}-family`}>
              <span>1. Тип изделия</span>
              <select id={`${prefix}-family`} value={familyId} onChange={(event) => {
                setFamilyId(event.target.value as SanhuaFamilyId | ''); setSize(''); setExecution(''); setQuery(''); setVisibleCount(12);
              }}>
                <option value="">Выберите тип изделия</option>
                {SANHUA_SELECTION_FAMILIES.map((entry) => <option value={entry.id} key={entry.id}>{entry.category}</option>)}
              </select>
            </label>
            <label htmlFor={`${prefix}-model`}>
              <span>2. Известная модель или артикул</span>
              <input id={`${prefix}-model`} type="search" value={query} disabled={!family} placeholder="Введите модель Sanhua или код товара" onChange={(event) => { setQuery(event.target.value); setVisibleCount(12); }} />
            </label>
          </div>

          {family ? (
            <>
              <fieldset className={styles.parameters}>
                <legend>3. Уточните данные из таблицы</legend>
                <label htmlFor={`${prefix}-size`}>
                  <span>Размер присоединения</span>
                  <select id={`${prefix}-size`} value={size} onChange={(event) => { setSize(event.target.value); setVisibleCount(12); }}>
                    <option value="">Все указанные размеры</option>
                    {options.sizes.map((entry) => <option value={entry.value} key={entry.value}>{entry.label}</option>)}
                  </select>
                </label>
                <label htmlFor={`${prefix}-execution`}>
                  <span>Соединение / исполнение</span>
                  <select id={`${prefix}-execution`} value={execution} onChange={(event) => { setExecution(event.target.value); setVisibleCount(12); }}>
                    <option value="">Все указанные исполнения</option>
                    {options.executions.map((value) => <option value={value} key={value}>{value}</option>)}
                  </select>
                </label>
              </fieldset>

              <aside className={styles.checklist}>
                <h4>Проверьте перед предложением клиенту</h4>
                <ul>{family.checklist.map((item) => <li key={item}>{item}</li>)}</ul>
                <p>Дюймовые и метрические размеры не объединяются автоматически. Совпадение строки таблицы не заменяет проверку условий работы и монтажа.</p>
              </aside>

              <div aria-live="polite">
                <h4 className={styles.resultTitle}>Позиций по таблице: {results.length}</h4>
                {!results.length ? <p className={styles.empty}>{options.count ? 'Сочетание не найдено. Проверьте модель или измените фильтры.' : 'Для этого типа пока нет сопоставленных с каталогом строк с достаточными данными о размере и исполнении. Неполные и противоречивые строки не включены в мастер.'}</p> : null}
                <div className={styles.results}>
                  {results.slice(0, visibleCount).map((candidate) => (
                    <article className={styles.card} key={candidate.id}>
                      <span>{candidate.brand}</span>
                      <h5>{candidate.model}</h5>
                      <dl>{candidate.technicalSpecifications.map((spec, index) => (
                        <div key={`${spec.label}:${index}`}><dt>{spec.label}</dt><dd>{formatSanhuaSpecification(spec)}</dd></div>
                      ))}</dl>
                      <AnalogCatalogAvailability items={candidate.catalogMatches} />
                      {candidate.note ? <p>{candidate.note}</p> : null}
                      <footer>{candidate.sourceFileName}{candidate.sourceSheet ? ` · ${candidate.sourceSheet}` : ''} · строка {candidate.sourceRow}</footer>
                      {onChooseModel ? <button type="button" onClick={() => onChooseModel(candidate.model)}>Посмотреть связи этой модели</button> : null}
                    </article>
                  ))}
                </div>
                {results.length > visibleCount ? <button className={styles.more} type="button" onClick={() => setVisibleCount((value) => value + 12)}>Показать ещё</button> : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <details className={styles.gaps}>
        <summary>Что дополнить техническому специалисту</summary>
        <p>Источник шагов: «Методика быстрого подбора компонентов SANHUA». Недостающие параметры не вычисляются из обозначения модели.</p>
        {[...SANHUA_SELECTION_FAMILIES, ...SANHUA_INCOMPLETE_BLOCKS].map((block) => (
          <div key={block.category}><h4>{block.category}</h4><p>{block.missing}</p></div>
        ))}
        <p>В кросс-таблице также нужно согласовать противоречия модели и наименования и подтвердить пары дюйм/метрика. Строки с отмеченным конфликтом исключены из мастера.</p>
      </details>
    </section>
  );
}
