// The Expo SDK owns this app's whole native surface, and nothing else in CI can
// see when a dependency bump contradicts it.
//
// `expo@<version>/bundledNativeModules.json` pins react-native, reanimated,
// worklets, screens, safe-area-context, gesture-handler, svg, react/react-dom and
// the expo-* family. Dependabot cannot consult that manifest, so it bumps whatever
// the semver range admits. On 2026-09-06 that produced PR #205: the expo-* half was
// exactly what expo@55.0.31 asks for, welded to react-native 0.83.10 -> 0.87.1,
// reanimated 4.2.1 -> 4.6.0 and worklets 0.7.4 -> 0.12.1, which 55.0.31 does not
// sanction. Typecheck, lint and the Node suite are all blind to it — the breakage is
// native, under two local Expo modules and two patches built against RN 0.83.
//
// `./scripts/ci.sh expo-deps` closes that hole by running `expo install --check`,
// which compares INSTALLED versions against the manifest and exits non-zero on
// drift. This guard keeps that job wired up.
//
// The load-bearing part is the PAIR of registrations in the gate. Adding the job to
// self-hosted-ci.yml is not enough:
//   - `expected` decides whether the gate VERIFIES the job ran in the manual run
//   - the `attest` matrix decides whether the context is PUBLISHED to the PR
// Half the edit yields a job that runs and enforces nothing, silently. That is the
// exact failure this file exists to make red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

const JOB_NAME = 'Expo SDK deps';

test('scripts/ci.sh exposes an expo-deps mode that runs expo install --check', async () => {
  const ci = await read('scripts/ci.sh');

  assert.match(ci, /run_expo_deps\(\) \{/, 'run_expo_deps must exist');
  assert.match(ci, /npx expo install --check/, 'the check itself must be expo install --check');

  // The mode must be dispatchable and Node-20-gated like its siblings.
  const mode = ci.match(/\n {2}expo-deps\)\n([\s\S]*?)\n {4};;/);
  assert.ok(mode, 'ci.sh must have an `expo-deps)` case branch');
  assert.match(mode[1], /require_node_20/);
  assert.match(mode[1], /run_expo_deps/);
  assert.match(ci, /Usage: \$0 \{[^}]*\bexpo-deps\b/, 'usage text must list the mode');

  // `npm run ci:linux` is the local mirror of CI, so it must carry the same gate —
  // and it already installs first, so the check sees real installed versions.
  const suite = ci.match(/run_linux_suite\(\) \{([\s\S]*?)\n\}/);
  assert.ok(suite, 'run_linux_suite must exist');
  assert.match(suite[1], /install_dependencies/);
  assert.match(suite[1], /run_expo_deps/);
  assert.ok(
    suite[1].indexOf('install_dependencies') < suite[1].indexOf('run_expo_deps'),
    'run_expo_deps must come after install_dependencies — it reads installed versions',
  );
});

test('the CI workflow runs the mode as its own job', async () => {
  const workflow = await read('.github/workflows/self-hosted-ci.yml');

  assert.match(workflow, new RegExp(`name: ${JOB_NAME}\\n`), 'job must be named for the check');
  assert.match(workflow, /run: \.\/scripts\/ci\.sh expo-deps/, 'job must invoke the mode');

  // A job that never installs would check an empty node_modules and pass vacuously.
  const job = workflow.match(/\n {2}expo-deps:\n([\s\S]*?)(?=\n {2}[a-z-]+:\n)/);
  assert.ok(job, 'an `expo-deps:` job must exist');
  assert.match(job[1], /run: npm ci/, 'the job must install before checking');
  assert.match(job[1], /needs: confirm-pr-head/);
  assert.match(job[1], /ref: \$\{\{ needs\.confirm-pr-head\.outputs\.head-sha \}\}/);
});

test('the PR gate both verifies and publishes the job — never only one', async () => {
  const gate = await read('.github/workflows/self-hosted-ci-gate.yml');

  // 1. verified: present in the `expected` Map the gate checks the manual run against
  assert.match(
    gate,
    new RegExp(`\\['${JOB_NAME}', runsOnLinux\\]`),
    `${JOB_NAME} must be in the gate's expected-jobs map, or the gate never confirms it ran`,
  );

  // 2. published: present in the attest matrix that attaches the context to the PR
  const matrix = gate.match(/matrix:\n\s+check:\n([\s\S]*?)\n {4}steps:/);
  assert.ok(matrix, "the attest job's check matrix must exist");
  assert.match(
    matrix[1],
    new RegExp(`- ${JOB_NAME}\\n`),
    `${JOB_NAME} must be in the attest matrix, or the required context is never published`,
  );
});

test('the SDK-pinned natives are ignored by Dependabot', async () => {
  const dependabot = await read('.github/dependabot.yml');

  // The versions expo's manifest owns. A bump here is only ever part of a
  // deliberate SDK upgrade, so Dependabot must not propose one weekly.
  for (const name of [
    'react',
    'react-dom',
    '@types/react',
    'react-native',
    'react-native-reanimated',
    'react-native-worklets',
    'react-native-screens',
    'react-native-safe-area-context',
    'react-native-gesture-handler',
    'react-native-svg',
  ]) {
    assert.match(
      dependabot,
      new RegExp(`- dependency-name: "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\n(?! *update-types)`),
      `${name} must be ignored for ALL update-types — 0.83 -> 0.87 is a MINOR, which the semver-major rule does not catch`,
    );
  }

  // Sentry is SDK-pinned at ~7.11.0, so minor/major are blocked but 7.11.x flows.
  assert.match(
    dependabot,
    /- dependency-name: "@sentry\/react-native"\n\s+update-types:\n\s+- "version-update:semver-minor"\n\s+- "version-update:semver-major"/,
  );
});
