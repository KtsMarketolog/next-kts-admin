import styles from '@/app/admin/admin.module.scss';
import type { UploadFeedback } from './topDashboardManagementModel';

export function UploadFeedbackMessage({ feedback, id }: { feedback: UploadFeedback | null; id: string }) {
  if (!feedback) return null;
  return <p
    id={id}
    className={`${styles.topDashboardUploadFeedback} ${feedback.kind === 'error' ? styles.topDashboardUploadError : styles.topDashboardUploadSuccess}`}
    role={feedback.kind === 'error' ? 'alert' : 'status'}
  >{feedback.message}</p>;
}
