/** Published pointers, not upload dates, define the working rollback pair. */
export function selectWorkingVersionPair<T extends { id: number }>(
  versions: readonly T[],
  activeVersionId: number | null,
  previousVersionId: number | null,
): T[] {
  const byId = new Map(versions.map((version) => [version.id, version]));
  return [...new Set([activeVersionId, previousVersionId])].flatMap((id) => {
    const version = id === null ? undefined : byId.get(id);
    return version ? [version] : [];
  });
}
