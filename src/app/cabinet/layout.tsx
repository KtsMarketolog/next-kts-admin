import type { ReactNode } from "react";

import { createPrivateMetadata } from "@/shared/lib/seo/privateMetadata";

export const metadata = createPrivateMetadata();

export default function CabinetLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
