import type { AdminSession } from './adminAuth';
import { hasDashboardIdentity } from './dashboardPermissions';

export const KNOWLEDGE_BASE_MAX_DEPTH = 12;
export const KNOWLEDGE_BASE_PAGE_SIZE = 50;
export const KNOWLEDGE_BASE_MAX_GRANTS = 1000;
export const KNOWLEDGE_BASE_MAX_FILE_BYTES = 25 * 1024 * 1024;
export type KnowledgeBaseAccess = { mode: 'inherit' | 'custom'; actorKeys: string[] };
export type KnowledgeBaseNode = {
  id: number; parentId: number | null; kind: 'folder' | 'file'; title: string; revision: string;
  archivedAt: string | null; createdAt: string; updatedAt: string;
  originalName: string | null; mimeType: string | null; size: number | null;
  access?: KnowledgeBaseAccess;
};
export type KnowledgeBaseActor = { actorKey: string; actorName: string; actorRole: string };
export type KnowledgeBaseList = { nodes: KnowledgeBaseNode[]; nextCursor: number | null; breadcrumbs: KnowledgeBaseNode[]; canManage: boolean };
export type KnowledgeBaseStatsRow = {
  key: string; title: string; role?: string; sectionOpens: number; folderOpens: number;
  fileViews: number; downloadsStarted: number; lastVisitAt: string; totalEvents: number;
};
export type KnowledgeBaseStatsPage = { rows: KnowledgeBaseStatsRow[]; nextCursor: string | null };
export const KNOWLEDGE_BASE_ACTIONS = ['section_open', 'folder_open', 'file_view', 'download_started'] as const;
export type KnowledgeBaseAction = typeof KNOWLEDGE_BASE_ACTIONS[number];
export type KnowledgeBaseCreate = { operationId: string; parentId: number | null; title: string; access?: KnowledgeBaseAccess };
export type KnowledgeBaseFileCreate = KnowledgeBaseCreate & {
  parentId: number; originalName: string; mimeType: string; size: number; storagePath: string; sha256: string;
};
export type KnowledgeBaseUpdate = { expectedRevision: string; title?: string; access?: KnowledgeBaseAccess };
export type KnowledgeBaseMoveInput = { expectedRevision: string; targetParentId: number | null };
export type KnowledgeBaseMoveCommit = KnowledgeBaseMoveInput & { previewToken: string };
export type KnowledgeBaseMovePreview = {
  source: KnowledgeBaseNode; destination: KnowledgeBaseNode | null; destinationBreadcrumbs: KnowledgeBaseNode[];
  previewToken: string; affectedCount: number; accessWarning: string;
};
export class KnowledgeBaseError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'KnowledgeBaseError'; }
}
export const knowledgeBaseInvalid = () => new KnowledgeBaseError(400, 'INVALID_INPUT', 'Некорректные данные базы знаний');
export const knowledgeBaseNotFound = () => new KnowledgeBaseError(404, 'NOT_FOUND', 'Материал не найден или недоступен');
export function isKnowledgeBaseManagementRole(role: string): boolean {
  return ['admin', 'admintop', 'top'].includes(role);
}
export function canManageKnowledgeBase(session: AdminSession | null | undefined): boolean {
  return hasDashboardIdentity(session) && isKnowledgeBaseManagementRole(session.role);
}
export function canAccessKnowledgeBase(session: AdminSession | null | undefined): session is AdminSession {
  return hasDashboardIdentity(session);
}
export function knowledgeBaseActorKey(session: AdminSession): string {
  if (!canAccessKnowledgeBase(session)) throw new KnowledgeBaseError(401, 'UNAUTHORIZED', 'Необходимо войти');
  if (session.role === 'manager' || session.role === 'support_manager') return `manager:${session.managerId}`;
  return session.adminUserId ? `admin:${session.adminUserId}` : 'admin:primary';
}
export function isKnowledgeBaseActorKey(value: unknown): value is string {
  return typeof value === 'string' && /^(admin|manager):[1-9][0-9]{0,14}$/.test(value);
}
export function assertKnowledgeBaseId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw knowledgeBaseInvalid();
}
export function assertKnowledgeBaseUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw knowledgeBaseInvalid();
}
export function parseKnowledgeBaseTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw knowledgeBaseInvalid();
  return value.trim();
}
export function parseKnowledgeBaseAccess(value: unknown, root = false): KnowledgeBaseAccess {
  if (value === undefined) return { mode: root ? 'custom' : 'inherit', actorKeys: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw knowledgeBaseInvalid();
  const access = value as Record<string, unknown>;
  if (Object.keys(access).some(key => !['mode', 'actorKeys'].includes(key)) || !['inherit', 'custom'].includes(String(access.mode))
    || !Array.isArray(access.actorKeys) || access.actorKeys.length > KNOWLEDGE_BASE_MAX_GRANTS
    || access.actorKeys.some(key => !isKnowledgeBaseActorKey(key)) || new Set(access.actorKeys).size !== access.actorKeys.length
    || (access.mode === 'inherit' && (root || access.actorKeys.length > 0))) throw knowledgeBaseInvalid();
  return { mode: access.mode as KnowledgeBaseAccess['mode'], actorKeys: [...access.actorKeys].sort() };
}
export function assertKnowledgeBaseRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > BigInt('9223372036854775807')) throw knowledgeBaseInvalid();
}
export function parseKnowledgeBaseSearch(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw knowledgeBaseInvalid();
  return value.trim();
}
