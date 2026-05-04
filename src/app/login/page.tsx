import { LoginPanel } from '@/features/auth/LoginPanel';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginPanel defaultMode="employee" />;
}
