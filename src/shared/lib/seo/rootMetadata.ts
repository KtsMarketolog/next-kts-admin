import type { Metadata } from "next";

type RootMetadataOptions = {
  yandexVerification?: string;
};

export function createRootMetadata({
  yandexVerification,
}: RootMetadataOptions = {}): Metadata {
  const normalizedYandexVerification = yandexVerification?.trim();

  return {
    title: "KTS",
    description: "Компоненты технических систем",
    ...(normalizedYandexVerification
      ? {
          verification: {
            yandex: normalizedYandexVerification,
          },
        }
      : {}),
  };
}
