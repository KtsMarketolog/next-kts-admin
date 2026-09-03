import type { Instrumentation } from 'next';

function safeRequestPath(path: string) {
  const pathname = path.split('?', 1)[0] || '/';
  return pathname
    .replace(/^\/price\/[^/]+/u, '/price/[redacted]')
    .replace(/^\/api\/price\/[^/]+/u, '/api/price/[redacted]');
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || !process.env.APP_RELEASE_ID) return;
  const { prepareRuntimeForRelease } = await import('@/shared/lib/runtimeStartup');
  await prepareRuntimeForRelease();
  console.log(JSON.stringify({
    event: 'runtime_ready',
    timestamp: new Date().toISOString(),
    release: process.env.APP_RELEASE_ID,
    instance: process.env.KTS_INSTANCE_ID ?? 'standalone',
  }));
}

export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  const message = error instanceof Error ? error.message : String(error);
  const digest = typeof error === 'object' && error !== null && 'digest' in error
    ? String(error.digest)
    : undefined;

  console.error(JSON.stringify({
    event: 'next_request_error',
    timestamp: new Date().toISOString(),
    release: process.env.APP_RELEASE_ID ?? 'unknown',
    instance: process.env.KTS_INSTANCE_ID ?? 'standalone',
    method: request.method,
    path: safeRequestPath(request.path),
    routePath: context.routePath,
    routeType: context.routeType,
    message: message.slice(0, 500),
    digest,
  }));
};
