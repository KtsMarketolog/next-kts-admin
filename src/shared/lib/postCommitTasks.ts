export type SavedOperationWarning = { code: string; message: string };

/** Secondary tasks must not turn a confirmed commit into a reported failed save. */
export async function runPostCommitTasks(
  tasks: (SavedOperationWarning & { run: () => unknown | Promise<unknown> })[],
): Promise<SavedOperationWarning[]> {
  const warnings: SavedOperationWarning[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch {
      warnings.push({ code: task.code, message: task.message });
      // Do not log request bodies, passwords or raw database/mail errors.
      console.error(JSON.stringify({ event: 'post_commit_task_failed', code: task.code }));
    }
  }
  return warnings;
}
