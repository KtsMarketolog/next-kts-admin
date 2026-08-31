export const PRODUCTION_SITE_ORIGIN = "https://kts-impex.ru";

type SiteUrlEnvironment = {
  SITE_URL?: string;
  NEXT_PUBLIC_SITE_URL?: string;
};

function currentEnvironment(): SiteUrlEnvironment {
  return {
    SITE_URL: process.env.SITE_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  };
}

function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(candidate);

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    return url.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function getCanonicalOrigin(
  environment: SiteUrlEnvironment = currentEnvironment(),
): string {
  return (
    normalizeOrigin(environment.SITE_URL) ??
    normalizeOrigin(environment.NEXT_PUBLIC_SITE_URL) ??
    PRODUCTION_SITE_ORIGIN
  );
}

export function canonicalUrl(
  path = "/",
  environment: SiteUrlEnvironment = currentEnvironment(),
): string {
  const origin = getCanonicalOrigin(environment);
  const normalizedPath = path.trim();

  if (!normalizedPath || normalizedPath === "/") return origin;

  const relativePath = normalizedPath.startsWith("/")
    ? normalizedPath
    : `/${normalizedPath}`;
  const url = new URL(relativePath, `${origin}/`);
  url.hash = "";
  return url.toString();
}
