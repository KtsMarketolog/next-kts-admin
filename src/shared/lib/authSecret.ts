export function getAdminSessionSecret() {
  const explicitSecret = process.env.ADMIN_SESSION_SECRET;
  if (explicitSecret) return explicitSecret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_SESSION_SECRET is required in production');
  }

  return process.env.ADMIN_PASSWORD || 'dev-secret';
}
