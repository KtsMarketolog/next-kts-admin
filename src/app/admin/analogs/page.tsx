import { redirect } from 'next/navigation';

export default function LegacyAdminAnalogsPage() {
  redirect('/admin/wholesale/manager?view=analogs');
}
