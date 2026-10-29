'use client';

import { useId, useState } from 'react';
import { DASHBOARD_INSTRUCTIONS, type DashboardInstructionKind } from '@/shared/lib/dashboardInstructions';
import styles from './DashboardInstructions.module.scss';

type Props = { dashboardKey: string; kind: DashboardInstructionKind };

export function DashboardInstructions(props: Props) {
  // Changing reports must unmount a playing video, including its pending requests.
  return <InstructionPanel key={`${props.dashboardKey}:${props.kind}`} {...props} />;
}

function InstructionPanel({ dashboardKey, kind }: Props) {
  const instruction = DASHBOARD_INSTRUCTIONS[kind];
  const headingId = useId();
  const playerId = useId();
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const href = `/api/admin/dashboard-instructions/${kind}?dashboardKey=${encodeURIComponent(dashboardKey)}`;
  const videoHref = `${href}&format=video`;
  return (
    <section className={styles.instructions} role="group" aria-labelledby={headingId} data-dashboard-instructions={dashboardKey}>
      <header className={styles.header}>
        <span className={styles.helpIcon} aria-hidden="true">?</span>
        <div>
          <h2 id={headingId}>Инструкции и видеообзор</h2>
          <p>{instruction.title} · материалы к версии {instruction.version}</p>
        </div>
      </header>
      <div className={styles.materials}>
        <div className={styles.material}>
          <span className={styles.badge}>PDF · {instruction.pages} стр.</span>
          <h3>Подробная инструкция</h3>
          <p>{kind === 'deal-profitability'
            ? 'Как загрузить счёт или КП, рассчитать рентабельность и подготовить лист согласования.'
            : 'Как читать показатели, пользоваться фильтрами и работать с отчётом.'}</p>
          <div className={styles.actions}>
            <a className={styles.primary} href={href} target="_blank" rel="noopener noreferrer" aria-label={`Открыть инструкцию «${instruction.title}» (PDF, новая вкладка)`}>Открыть PDF</a>
            <a href={`${href}&download=1`} download={instruction.downloadName} aria-label={`Скачать инструкцию «${instruction.title}» (PDF)`}>Скачать PDF</a>
          </div>
        </div>
        <div className={styles.material}>
          <span className={styles.badge}>ВИДЕО · {instruction.video.duration}</span>
          <h3>Краткий видеообзор</h3>
          <p>Наглядное знакомство с разделами и возможностями дашборда.</p>
          <div className={styles.actions}>
            <button className={styles.primary} type="button" aria-expanded={videoOpen} aria-controls={playerId} onClick={() => {
              setVideoOpen((open) => !open);
              setVideoError(false);
            }}><span aria-hidden="true">{videoOpen ? '×' : '▶'}</span>{videoOpen ? 'Закрыть видео' : 'Смотреть видео'}</button>
            <a href={`${videoHref}&download=1`} download={instruction.video.downloadName} aria-label={`Скачать видеообзор «${instruction.title}» (MP4)`}>Скачать видео</a>
          </div>
        </div>
      </div>
      <div id={playerId} hidden={!videoOpen} className={styles.player}>
        {videoOpen ? <>
          <video src={videoHref} controls preload="metadata" playsInline aria-label={`Видеообзор: ${instruction.title}`} onError={() => setVideoError(true)}>
            Ваш браузер не поддерживает просмотр видео. Воспользуйтесь ссылкой для скачивания.
          </video>
          {videoError ? <p role="alert">Не удалось загрузить видео. Обновите страницу и проверьте вход в кабинет или попробуйте скачать файл.</p> : null}
          <a href={videoHref} target="_blank" rel="noopener noreferrer">Открыть видео в новой вкладке</a>
        </> : null}
      </div>
    </section>
  );
}
