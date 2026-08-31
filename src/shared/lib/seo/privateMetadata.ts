import type { Metadata } from "next";

export function createPrivateMetadata(): Metadata {
  return {
    robots: {
      index: false,
      follow: false,
      nocache: true,
    },
  };
}
