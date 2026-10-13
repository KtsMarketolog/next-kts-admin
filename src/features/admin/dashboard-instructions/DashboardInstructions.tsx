import { DASHBOARD_INSTRUCTIONS, type DashboardInstructionKind } from '@/shared/lib/dashboardInstructions';
import styles from './DashboardInstructions.module.scss';

export function DashboardInstructions({ dashboardKey, kind }: { dashboardKey: string; kind: DashboardInstructionKind }) {
  const instruction = DASHBOARD_INSTRUCTIONS[kind];
  const href = `/api/admin/dashboard-instructions/${kind}?dashboardKey=${encodeURIComponent(dashboardKey)}`;
  return (
    <div className={styles.instructions} role="group" aria-label={`Инструкция: ${instruction.title}`}>
      <span className={styles.label}>Инструкция <span>PDF · {instruction.version} · {instruction.pages} стр.</span></span>
      <div className={styles.actions}>
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Открыть инструкцию «${instruction.title}» (PDF, новая вкладка)`}>Открыть</a>
        <a href={`${href}&download=1`} download={instruction.downloadName} aria-label={`Скачать инструкцию «${instruction.title}» (PDF)`}>Скачать</a>
      </div>
    </div>
  );
}
