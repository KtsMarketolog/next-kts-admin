import type { KnowledgeBaseNode } from './knowledgeBase';

export type KnowledgeBaseDeleteInput = { expectedRevision: string };
export type KnowledgeBaseDeleteCommit = KnowledgeBaseDeleteInput & {
  previewToken: string; confirmationTitle: string; operationId: string;
};
export type KnowledgeBaseDeleteCounts = { affectedCount: number; fileCount: number; folderCount: number; totalBytes: number };
export type KnowledgeBaseDeletePreview = KnowledgeBaseDeleteCounts & { source: KnowledgeBaseNode; previewToken: string };
export type KnowledgeBaseDeleteResult = KnowledgeBaseDeleteCounts & {
  deleted: true; nodeId: number; cleanupPending: boolean;
};
