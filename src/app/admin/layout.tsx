import type { ReactNode } from "react";

import { createPrivateMetadata } from "@/shared/lib/seo/privateMetadata";
import { getAdminSession } from "@/shared/lib/adminAuth";
import { DashboardUsageDeliveryProvider } from "@/features/admin/dashboard-usage/DashboardUsageDeliveryProvider";

export const metadata = createPrivateMetadata();

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getAdminSession();
  return <DashboardUsageDeliveryProvider sessionId={session?.sessionId ?? null}>{children}</DashboardUsageDeliveryProvider>;
}
