const V2_PREFIX = 'durable-upload-v2-';
const LEGACY_PREFIX = 'durable-upload-';

let launchSeed = 0;
let attemptCounter = 0;

function createLaunchToken(): string {
  launchSeed += 1;
  try {
    const time = Math.max(0, Math.trunc(Date.now())).toString(36);
    const random = Math.max(
      0,
      Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER),
    ).toString(36);
    return `${time}${random}${launchSeed.toString(36)}`;
  } catch {
    // Module initialization must never throw. This is ownership uniqueness,
    // not a security identifier, so a JS-only fallback is sufficient.
    return `fallback${launchSeed.toString(36)}`;
  }
}

const CURRENT_LAUNCH_TOKEN = createLaunchToken();
const V2_PATTERN =
  /^durable-upload-v2-([a-z0-9]+)-([1-9][0-9]*)\.aac$/;
const LEGACY_UUID_PATTERN =
  /^durable-upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.aac$/i;
// Durable ids created by 1.13.17 are `dr-` plus 32 hex characters. Keep this
// exact sibling of the UUID form so real leftovers are cleaned without
// broadening the namespace to arbitrary `.aac` files.
const LEGACY_DURABLE_ID_PATTERN =
  /^durable-upload-dr-[0-9a-f]{32}\.aac$/i;

export function createDurableUploadSnapshotBasename(): string {
  attemptCounter += 1;
  return `${V2_PREFIX}${CURRENT_LAUNCH_TOKEN}-${attemptCounter}.aac`;
}

export function createDurableUploadSnapshotUri(cacheUri: string): string {
  const root = cacheUri.endsWith('/') ? cacheUri : `${cacheUri}/`;
  return `${root}${createDurableUploadSnapshotBasename()}`;
}

export function isDurableUploadSnapshotBasename(name: string): boolean {
  return V2_PATTERN.test(name);
}

export function isCurrentLaunchDurableUploadSnapshotBasename(
  name: string,
): boolean {
  return V2_PATTERN.exec(name)?.[1] === CURRENT_LAUNCH_TOKEN;
}

export function isLegacyDurableUploadSnapshotBasename(
  name: string,
): boolean {
  return (
    name.startsWith(LEGACY_PREFIX) &&
    (LEGACY_UUID_PATTERN.test(name) ||
      LEGACY_DURABLE_ID_PATTERN.test(name))
  );
}

export function isStaleDurableUploadSnapshotBasename(
  name: string,
): boolean {
  if (isLegacyDurableUploadSnapshotBasename(name)) return true;
  if (!isDurableUploadSnapshotBasename(name)) return false;
  return !isCurrentLaunchDurableUploadSnapshotBasename(name);
}
