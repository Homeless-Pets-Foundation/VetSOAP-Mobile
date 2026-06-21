import type { RecordingTask } from '../types';

// Pure helpers for the Suggested Tasks feature. Kept free of React Native
// imports so the .mjs test loader can transpile + execute this module directly.

// Billing group first (matches web), only non-empty groups retained.
// Tasks of all statuses are kept — resolved items render muted, not filtered.
export function groupRecordingTasks(tasks: RecordingTask[]) {
  return (['billing', 'todo'] as const)
    .map((type) => ({ type, tasks: tasks.filter((t) => t.type === type) }))
    .filter((g) => g.tasks.length > 0);
}

// Shape guard for GET /api/recordings/:id/tasks, which responds { data: [...] }.
// Server can send unexpected shapes / null body (rule 10) — always return an array.
export function unwrapTaskList(res: { data?: unknown } | null | undefined): RecordingTask[] {
  return res && Array.isArray(res.data) ? (res.data as RecordingTask[]) : [];
}
