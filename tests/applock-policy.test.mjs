// AppLockGuard hung-bridge defense (rule 24).
//
// Shipped symptom: `AppLockGuard`'s foreground-resume branch called
// setIsLocked(true) and then awaited biometrics.isAvailable() / isEnabled() /
// authenticate() with nothing bounding them. Every method on
// src/lib/biometrics.ts already try/catches to a safe value and NEVER rejects,
// so a hang is the only remaining failure mode and no try/catch reaches it. A
// stalled Keystore or local-authentication bridge therefore locked a vet out of
// a perfectly valid session, with un-uploaded recordings behind the lock.
//
// Three siblings found in the same component and fixed with it:
//   B. the cold-start watchdog was cleared in the outer .finally(), which waits
//      on the prompt — so hesitating >12s at the OS prompt made the app unlock
//      itself BEHIND a live biometric prompt, with no authentication.
//   C. that watchdog firing left the (then boolean) shouldLockOnBgRef false,
//      silently disarming the background lock for the rest of the session.
//   D. attemptUnlock was unbounded too: a hang stranded isAuthenticatingRef
//      true, so the early-return made every retry a no-op and pinned the Unlock
//      button spinning.
//
// The decision table lives in src/lib/appLockPolicy.ts precisely so it can be
// EXECUTED here — tests/helpers/loadTs.mjs resolves .ts only, never .tsx, so
// anything left in the component is testable by regex alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

const policy = () => loadTsModule('src/lib/appLockPolicy.ts');

const RESOLVED = (available, enabled) => ({ kind: 'resolved', available, enabled });
const TIMEOUT = { kind: 'timeout' };

test('probe: a configured lock routes to the prompt on both paths', async () => {
  const { decideAfterProbe } = await policy();
  for (const path of ['init', 'resume']) {
    const decision = decideAfterProbe(path, 'unknown', RESOLVED(true, true));
    assert.equal(decision.action, 'prompt');
    assert.equal(decision.bgLock, 'on');
    assert.equal(decision.telemetry, null);
  }
});

test('probe: a proven-absent lock settles unlocked and records bgLock off', async () => {
  const { decideAfterProbe } = await policy();
  for (const [available, enabled] of [[false, false], [true, false], [false, true]]) {
    const decision = decideAfterProbe('init', 'unknown', RESOLVED(available, enabled));
    assert.equal(decision.action, 'settle');
    assert.equal(decision.locked, false);
    assert.equal(decision.ready, true);
    assert.equal(decision.bgLock, 'off');
  }
});

test('probe: a stale cached lock is cleared when resume proves it is off', async () => {
  const { decideAfterProbe } = await policy();
  const decision = decideAfterProbe('resume', 'on', RESOLVED(true, false));
  assert.equal(decision.action, 'settle');
  assert.equal(decision.locked, false);
  assert.equal(decision.bgLock, 'off');
});

test('probe: cold-start timeout fails OPEN under the original event name', async () => {
  // Failing closed here would lock out every user who never enabled biometrics,
  // out of an app they never locked. The event name is deliberately unchanged
  // so the existing Sentry issue history stays continuous.
  const { decideAfterProbe } = await policy();
  const decision = decideAfterProbe('init', 'unknown', TIMEOUT);
  assert.equal(decision.action, 'settle');
  assert.equal(decision.locked, false);
  assert.equal(decision.ready, true);
  assert.equal(decision.telemetry.message, 'applock_init_watchdog_fired');
});

test('probe: cold-start timeout does NOT force bgLock off (defect C)', async () => {
  // The disarm bug: forcing 'off' here left the background lock silently
  // inoperative for the whole session.
  const { decideAfterProbe } = await policy();
  assert.equal(decideAfterProbe('init', 'unknown', TIMEOUT).bgLock, 'unknown');
  assert.equal(decideAfterProbe('init', 'on', TIMEOUT).bgLock, 'on');
});

test('probe: resume timeout with a KNOWN lock still prompts', async () => {
  const { decideAfterProbe } = await policy();
  const decision = decideAfterProbe('resume', 'on', TIMEOUT);
  assert.equal(decision.action, 'prompt');
  assert.equal(decision.bgLock, 'on');
});

test('probe: resume timeout with an UNKNOWN lock fails open, not into a prompt', async () => {
  // Prompting here could strand a non-biometric user behind a lock screen they
  // can never satisfy — the biometric setting lives in Settings, behind this
  // very guard.
  const { decideAfterProbe } = await policy();
  const decision = decideAfterProbe('resume', 'unknown', TIMEOUT);
  assert.equal(decision.action, 'settle');
  assert.equal(decision.locked, false);
  assert.equal(decision.telemetry.message, 'applock_resume_probe_unknown');
});

test('prompt: success unlocks and clears the hint on every path', async () => {
  const { decideAfterPrompt } = await policy();
  for (const path of ['init', 'resume', 'manual']) {
    const decision = decideAfterPrompt(path, 'success');
    assert.equal(decision.locked, false);
    assert.equal(decision.hint, null);
    assert.equal(decision.telemetry, null);
  }
});

test('prompt: a cancel stays locked with the cancelled hint and no telemetry', async () => {
  const { decideAfterPrompt } = await policy();
  for (const path of ['init', 'resume', 'manual']) {
    const decision = decideAfterPrompt(path, 'rejected');
    assert.equal(decision.locked, true);
    assert.match(decision.hint, /cancelled/i);
    assert.equal(decision.telemetry, null, 'a cancel is ordinary use, not a fault');
  }
});

test('prompt: a HANG stays locked on every path — PHI is never revealed on a timer', async () => {
  const { decideAfterPrompt } = await policy();
  for (const path of ['init', 'resume', 'manual']) {
    assert.equal(decideAfterPrompt(path, 'timeout').locked, true);
  }
});

test('prompt: a hang is reported separately from a cancel, and resume has its own name', async () => {
  const { decideAfterPrompt } = await policy();
  const resume = decideAfterPrompt('resume', 'timeout');
  assert.equal(resume.telemetry.message, 'applock_resume_watchdog_fired');
  for (const path of ['init', 'manual']) {
    assert.equal(
      decideAfterPrompt(path, 'timeout').telemetry.message,
      'applock_prompt_watchdog_fired',
    );
  }
  // Distinct copy: "try again" alone would blame the user for a prompt they
  // never saw.
  assert.notEqual(resume.hint, decideAfterPrompt('resume', 'rejected').hint);
});

test('prompt: every hang telemetry carries the prompt deadline, not the probe one', async () => {
  const { decideAfterPrompt, APPLOCK_PROMPT_TIMEOUT_MS } = await policy();
  for (const path of ['init', 'resume', 'manual']) {
    assert.equal(
      decideAfterPrompt(path, 'timeout').telemetry.timeoutMs,
      APPLOCK_PROMPT_TIMEOUT_MS,
    );
  }
});

test('coarse watchdog: resume leaves isLocked alone; cold start still fails open', async () => {
  const { decideCoarseWatchdog } = await policy();

  const resume = decideCoarseWatchdog('resume');
  assert.equal(resume.locked, null, 'null = do not touch isLocked');
  assert.equal(resume.releaseAuthenticating, true, 'the Unlock button must work again');
  assert.equal(resume.telemetry.message, 'applock_resume_watchdog_fired');
  assert.ok(resume.hint, 'the lock screen must say why it is still up');

  const init = decideCoarseWatchdog('init');
  assert.equal(init.locked, false);
  assert.equal(init.ready, true);
  assert.equal(init.telemetry.message, 'applock_init_watchdog_fired');
});

test('deadlines are ordered so the tactical layer fires before the coarse one', async () => {
  const mod = await policy();
  assert.ok(
    mod.APPLOCK_PROBE_TIMEOUT_MS < mod.APPLOCK_INIT_WATCHDOG_MS,
    'the probe must time out before the cold-start watchdog',
  );
  assert.ok(
    mod.APPLOCK_PROBE_TIMEOUT_MS < mod.APPLOCK_RESUME_WATCHDOG_MS,
    'the probe must time out before the resume watchdog',
  );
  assert.ok(
    mod.APPLOCK_PROMPT_TIMEOUT_MS > mod.APPLOCK_RESUME_WATCHDOG_MS,
    'the prompt is user-driven; its deadline must not undercut a real person',
  );
});

test('the __DEV__ hang failpoint is inert outside development', async () => {
  // loadTs runs with __DEV__ false, matching a release bundle.
  const { armAppLockHang, getArmedAppLockHang, consumeAppLockHang } = await policy();
  assert.equal(armAppLockHang('resume:prompt'), false);
  assert.equal(getArmedAppLockHang(), null);
  assert.equal(consumeAppLockHang('resume:prompt'), false);
});

test('the failpoint key names a stage, so probe and prompt are armable separately', async () => {
  // Keying on the path alone let the probe consume the one-shot, leaving the
  // prompt branch — the one that must fail CLOSED — permanently unreachable
  // for on-device verification.
  const { isLockFailpoint } = await policy();
  for (const path of ['init', 'resume', 'manual']) {
    for (const stage of ['probe', 'prompt']) {
      assert.equal(isLockFailpoint(`${path}:${stage}`), true);
    }
  }
  for (const bad of ['resume', 'prompt', 'resume:', ':prompt', 'resume:sensor', '', 42, null]) {
    assert.equal(isLockFailpoint(bad), false, `should reject ${String(bad)}`);
  }
});

// --- Component wiring (source text — .tsx cannot be executed here) ---

test('AppLockGuard routes every biometric call through a bounded helper', async () => {
  const src = await read('src/components/AppLockGuard.tsx');

  assert.match(src, /withPromiseTimeout\(/, 'the tactical inner layer must be present');
  assert.match(src, /APPLOCK_PROBE_TIMEOUT_MS/);
  assert.match(src, /APPLOCK_PROMPT_TIMEOUT_MS/);

  // No bare biometric await may survive outside probeGate/runPrompt.
  const bareProbe = /await\s+Promise\.all\(\s*\[\s*biometrics\.isAvailable/;
  assert.doesNotMatch(src, bareProbe, 'the availability probe must be bounded');
  assert.doesNotMatch(
    src,
    /const\s+success\s*=\s*await\s+biometrics\.authenticate/,
    'the prompt must be bounded',
  );
});

test('AppLockGuard arms a coarse watchdog on the RESUME path (the reported gap)', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(src, /APPLOCK_RESUME_WATCHDOG_MS/);
  assert.match(src, /decideCoarseWatchdog\('resume'\)/);
});

test('AppLockGuard clears the cold-start watchdog before the prompt starts (defect B)', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  const probe = src.indexOf("await probeGate('init')");
  const clear = src.indexOf('clearTimeout(watchdog)', probe);
  const prompt = src.indexOf("runPrompt(consumeAppLockHang('init:prompt'))");
  assert.ok(probe >= 0 && clear >= 0 && prompt >= 0, 'cold-start path shape changed');
  assert.ok(
    clear < prompt,
    'the watchdog must be cleared before the prompt — otherwise it unlocks behind a live prompt',
  );
});

test('AppLockGuard never unlocks from a timer on the resume path', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  // The only literal unlock left is the cold-start defensive catch; the resume
  // watchdog must go through decideCoarseWatchdog, which returns locked: null.
  const resumeStart = src.indexOf('Background/foreground lock handler');
  const resumeBody = src.slice(resumeStart);
  assert.ok(resumeStart >= 0, 'resume handler comment changed');
  assert.doesNotMatch(
    resumeBody,
    /setIsLocked\(false\)/,
    'the resume path must derive isLocked from the policy module, never set it false inline',
  );
});

test('AppLockGuard uses the tri-state bg-lock cache, not a boolean (defect C)', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  assert.match(src, /bgLockRef\s*=\s*useRef<BgLockState>\('unknown'\)/);
  assert.doesNotMatch(src, /shouldLockOnBgRef/, 'the boolean ref must be gone');
  // 'unknown' must still arm the resume check — only a proven 'off' skips it.
  assert.match(src, /bgLockRef\.current\s*!==\s*'off'/);
});

test('attemptUnlock is bounded and always releases the re-entrancy ref (defect D)', async () => {
  const src = await read('src/components/AppLockGuard.tsx');
  const start = src.indexOf('const attemptUnlock');
  const body = src.slice(start, src.indexOf('}, []);', start));
  assert.ok(start >= 0, 'attemptUnlock changed shape');
  assert.match(body, /runPrompt\(consumeAppLockHang\('manual:prompt'\)\)/);
  assert.match(body, /finally \{[\s\S]*isAuthenticatingRef\.current = false/);
});

test('lock-screen copy lives in the strings catalog', async () => {
  const [src, strings] = await Promise.all([
    read('src/components/AppLockGuard.tsx'),
    read('src/constants/strings.ts'),
  ]);
  assert.match(strings, /export const APP_LOCK_COPY = \{/);
  assert.match(strings, /sensorUnavailable:/);
  assert.match(src, /APP_LOCK_COPY\.title/);
  assert.doesNotMatch(src, /'Captivet Locked'/, 'title must come from the catalog');
  assert.doesNotMatch(src, /'Authentication cancelled/, 'hint must come from the catalog');
});
