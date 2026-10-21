import { matchesDecodedPath } from './clientDocumentPaths';
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export function isKnowledgeBaseStoragePath(value: string) {
  return matchesDecodedPath(value, path => within(path, '/uploads/knowledge-base'));
}
export function isPrivateKnowledgeBaseImageSource(value: string) {
  return matchesDecodedPath(value, path => within(path, '/uploads/knowledge-base') || within(path, '/api/admin/knowledge-base/files'));
}
export function blocksPublicKnowledgeBaseRequest(url: Pick<URL, 'pathname' | 'searchParams'>) {
  if (isKnowledgeBaseStoragePath(url.pathname)) return true;
  return matchesDecodedPath(url.pathname, path => within(path, '/_next/image'))
    && url.searchParams.getAll('url').some(isPrivateKnowledgeBaseImageSource);
}
