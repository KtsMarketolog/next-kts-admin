import type { ReactNode } from "react";

import { createPrivateMetadata } from "@/shared/lib/seo/privateMetadata";

export const metadata = createPrivateMetadata();

export default function LoginLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
