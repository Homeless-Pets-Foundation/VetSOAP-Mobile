#!/usr/bin/env node
/**
 * Post-build verification that Sentry received this release's source maps.
 *
 * Run after an EAS build completes (or from CI after the Sentry upload step).
 * A symbolicated crash stack requires the JS bundle + its source map to be
 * present on Sentry under the release identifier. Silent upload failures
 * happen (flaky network, token rotation, wrong project slug) and make every
 * Sentry issue from that release unreadable.
 *
 * Inputs (env):
 *   SENTRY_AUTH_TOKEN         — personal or service token with project:read
 *   SENTRY_ORG                — slug, e.g. `homeless-pets-foundation`
 *   SENTRY_PROJECT            — mobile project slug, e.g. `captivet-mobile`
 *   APP_VERSION (optional)    — release version; defaults to package.json
 *
 * Exit codes:
 *   0 — release has at least one source map artifact (passes)
 *   1 — release exists but contains zero source maps (FAIL)
 *   2 — release does not exist on Sentry (FAIL — upload never happened)
 *   3 — config/env error (skipped, treated as non-fatal)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const token = process.env.SENTRY_AUTH_TOKEN;
const org = process.env.SENTRY_ORG;
const project = process.env.SENTRY_PROJECT;

if (!token || !org || !project) {
  console.warn('[verify-sourcemaps] Missing SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT — skipping');
  process.exit(3);
}

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'));
const version = process.env.APP_VERSION ?? pkg.version;

if (!version) {
  console.error('[verify-sourcemaps] Could not resolve APP_VERSION');
  process.exit(3);
}

const releaseUrl = `https://sentry.io/api/0/projects/${org}/${project}/releases/${encodeURIComponent(version)}/files/`;

try {
  const res = await fetch(releaseUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 404) {
    console.error(`[verify-sourcemaps] Release ${version} not found on Sentry (${releaseUrl})`);
    process.exit(2);
  }

  if (!res.ok) {
    console.error(`[verify-sourcemaps] Unexpected status ${res.status} from ${releaseUrl}`);
    process.exit(1);
  }

  const files = await res.json();
  if (!Array.isArray(files) || files.length === 0) {
    console.error(`[verify-sourcemaps] Release ${version} has zero artifacts`);
    process.exit(1);
  }

  const sourceMaps = files.filter((f) => typeof f?.name === 'string' && f.name.endsWith('.map'));
  if (sourceMaps.length === 0) {
    console.error(`[verify-sourcemaps] Release ${version} has ${files.length} artifacts but no .map files`);
    process.exit(1);
  }

  console.log(`[verify-sourcemaps] OK: ${version} has ${sourceMaps.length} source map(s) of ${files.length} artifact(s)`);
  process.exit(0);
} catch (err) {
  console.error('[verify-sourcemaps] Fetch failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
