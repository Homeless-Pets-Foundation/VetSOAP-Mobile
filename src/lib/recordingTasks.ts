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

// Task IDs are server UUIDs. Rejecting anything else here also blocks
// path-traversal ids ('.', '..', 'a/b') from ever reaching the PATCH URL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_TYPES = new Set<RecordingTask['type']>(['todo', 'billing']);
const TASK_STATUSES = new Set<RecordingTask['status']>([
  'suggested',
  'accepted',
  'dismissed',
  'done',
]);

// Validate + normalize a single item from the /tasks response. A malformed
// entry (null, missing/non-string fields, unknown type/status) is dropped
// rather than rendered — the card derefs t.type/t.title/t.detail, so a bad
// item could otherwise crash or blank the recording detail screen.
function normalizeTask(raw: unknown): RecordingTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !UUID_RE.test(t.id)) return null;
  if (typeof t.title !== 'string') return null;
  if (!TASK_TYPES.has(t.type as RecordingTask['type'])) return null;
  if (!TASK_STATUSES.has(t.status as RecordingTask['status'])) return null;
  const detail = typeof t.detail === 'string' ? t.detail : null;
  return {
    id: t.id,
    type: t.type as RecordingTask['type'],
    title: t.title,
    detail,
    status: t.status as RecordingTask['status'],
  };
}

// Shape guard for GET /api/recordings/:id/tasks, which responds { data: [...] }.
// Server can send unexpected shapes / null body (rule 10) — always return an
// array of well-formed tasks (malformed items filtered out).
export function unwrapTaskList(res: { data?: unknown } | null | undefined): RecordingTask[] {
  const arr = res && Array.isArray(res.data) ? res.data : [];
  return arr.map(normalizeTask).filter((t): t is RecordingTask => t !== null);
}

// AI tasks are created by the post-SOAP enrichment job a few seconds AFTER a
// recording reaches 'completed'. A recording viewed in that window fetches an
// empty list and (without this) caches it forever, hiding the card even after
// the tasks exist server-side. Poll briefly while the list is empty so it
// self-heals; stop once tasks arrive, when backgrounded, or once we're well
// past completion (then an empty list is genuinely empty — many recordings
// legitimately have zero suggested tasks, so we must not poll them forever).
const TASKS_POLL_WINDOW_MS = 10 * 60 * 1000; // 10 min after completion

export function getTasksRefetchInterval(opts: {
  tasksCount: number;
  appActive: boolean;
  completedAtMs: number | null; // Date.parse(recording.processingCompletedAt)
  nowMs: number;
  attempts: number; // query.state.dataUpdateCount
}): number | false {
  const { tasksCount, appActive, completedAtMs, nowMs, attempts } = opts;
  if (!appActive) return false;
  if (tasksCount > 0) return false;
  if (completedAtMs != null && nowMs - completedAtMs > TASKS_POLL_WINDOW_MS) return false;
  // Backoff 5s → 7.5s → … capped at 30s (same shape as the recording query).
  return Math.min(5_000 * Math.pow(1.5, attempts), 30_000);
}
