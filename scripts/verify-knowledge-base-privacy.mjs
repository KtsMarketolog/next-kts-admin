import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_DOCUMENT_PROBE_ORIGINS, CLIENT_DOCUMENT_PROBE_PATHS, requestStatus } from './verify-client-document-privacy.mjs';

export const KNOWLEDGE_BASE_PROBE_PATHS = CLIENT_DOCUMENT_PROBE_PATHS.map(value => value
  .replaceAll('client-documents', 'knowledge-base').replaceAll('client%2Ddocuments', 'knowledge%2Dbase'));

export async function verifyKnowledgeBasePrivacy({ origins = CLIENT_DOCUMENT_PROBE_ORIGINS, optimizer = false, request = requestStatus } = {}) {
  if (!origins.length) throw new Error('At least one privacy probe origin is required');
  let checked = 0;
  for (const origin of origins) {
    for (const pathname of KNOWLEDGE_BASE_PROBE_PATHS) for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const status = await request(origin, pathname, method);
      if (status !== 403 && !(method === 'OPTIONS' && status === 405)) throw new Error(`KB private upload guard failed: ${method} ${origin}${pathname} returned ${status}, expected 403`);
      checked++;
    }
    if (optimizer) for (const source of ['/uploads/knowledge-base/__privacy_probe__.png', '/api/admin/knowledge-base/files/1?mode=preview']) {
      const status = await request(origin, `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`, 'GET');
      if (status !== 403) throw new Error(`KB optimizer privacy guard failed: ${status}, expected 403`);
      checked++;
    }
    for (const pathname of ['/uploads/__kts_public_upload_probe__.svg', '/uploads/knowledge-base-other/__kts_public_upload_probe__.svg']) {
      const status = await request(origin, pathname, 'HEAD');
      if (!Number.isInteger(status) || status < 200 || status >= 500 || status === 403) throw new Error(`Public upload regression: ${pathname} returned ${status}`);
      checked++;
    }
  }
  return { checked, origins: origins.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const optimizer = args.includes('--optimizer');
  const origins = args.filter(value => value !== '--optimizer');
  verifyKnowledgeBasePrivacy({ origins: origins.length ? origins : CLIENT_DOCUMENT_PROBE_ORIGINS, optimizer }).then(result => {
    console.log(`Knowledge base private storage verified: ${result.checked} anonymous probes.`);
  }).catch(error => { console.error(error instanceof Error ? error.message : 'KB privacy verification failed'); process.exitCode = 1; });
}
