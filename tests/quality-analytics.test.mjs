import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requireForVm = createRequire(import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function loadQualityAnalytics(apiClient = {}) {
  const source = await read('src/api/qualityAnalytics.ts');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;

  const module = { exports: {} };
  const requireShim = (id) => {
    if (id === './client') return { apiClient };
    return requireForVm(id);
  };

  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireShim,
  });
  return module.exports;
}

// Arrays and objects the module builds itself (e.g. the alert list literal)
// carry the vm context's prototypes, which deepStrictEqual rejects on identity
// alone. Compare structure. Values derived from a host array (filter/sort/map)
// stay host-realm and need no normalization.
const plain = (value) => JSON.parse(JSON.stringify(value));

function summary(overrides = {}) {
  return {
    completedRecordings: 4,
    averageRecordingLengthSeconds: 320,
    failedUploadAttempts: 1,
    silentAudioEvents: 0,
    reprocessCount: 2,
    reprocessRate: 0.5,
    soapEditedCount: 1,
    soapEditRate: 0.25,
    missingMetadataCount: 1,
    missingMetadataRate: 0.25,
    processingLatencyAvgSeconds: 30,
    processingLatencyP50Seconds: 25,
    processingLatencyP90Seconds: 45,
    ...overrides,
  };
}

function breakdown(overrides = {}) {
  return {
    key: 'Wellness',
    label: 'Wellness',
    ...summary({ completedRecordings: 12 }),
    ...overrides,
  };
}

// A breakdown group with every count-based problem zeroed. Tests of the
// completion-sample rule must use this: `breakdown()` inherits
// failedUploadAttempts: 1 and reprocessCount: 2 from `summary()`, which the
// count-based retention path would keep regardless of sample size — a
// sample-filter test built on it passes for the wrong reason.
function cleanBreakdown(overrides = {}) {
  return breakdown({
    failedUploadAttempts: 0,
    silentAudioEvents: 0,
    reprocessCount: 0,
    reprocessRate: 0,
    soapEditedCount: 0,
    soapEditRate: 0,
    missingMetadataCount: 0,
    missingMetadataRate: 0,
    ...overrides,
  });
}

function envelope(overrides = {}) {
  return {
    periodDays: 30,
    recentRecordings: [{ patientName: 'Ruby' }],
    quality: {
      org: summary(),
      me: summary({ completedRecordings: 1, reprocessRate: 2 }),
      byAppointmentType: [breakdown()],
      byModel: [breakdown({ key: 'gemini-2.5-flash', label: 'gemini-2.5-flash' })],
      byProvider: [
        {
          ...summary(),
          userId: '6e3c1f9a-9f0b-4f3a-8c2d-1a2b3c4d5e6f',
          fullName: 'Dr. Vet',
          role: 'veterinarian',
          lastRecordingAt: '2026-06-09T12:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

test('parseDashboardQualityEnvelope parses only periodDays and quality', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  const parsed = parseDashboardQualityEnvelope(envelope());

  assert.equal(parsed.periodDays, 30);
  assert.equal(parsed.quality.org.completedRecordings, 4);
  assert.equal(parsed.quality.byAppointmentType[0].label, 'Wellness');
  assert.equal(parsed.quality.byModel[0].label, 'gemini-2.5-flash');
  assert.equal(parsed.quality.byProvider[0].fullName, 'Dr. Vet');
  assert.equal('recentRecordings' in parsed, false);
});

test('parseDashboardQualityEnvelope accepts older non-admin personal-only quality', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  const parsed = parseDashboardQualityEnvelope(
    envelope({
      quality: {
        org: null,
        me: summary({ completedRecordings: 2 }),
        byProvider: null,
      },
    })
  );

  assert.equal(parsed.quality.org, null);
  assert.equal(parsed.quality.me.completedRecordings, 2);
  assert.deepEqual(parsed.quality.byAppointmentType, []);
  assert.deepEqual(parsed.quality.byModel, []);
  assert.equal(parsed.quality.byProvider, null);
});

test('parseDashboardQualityEnvelope defaults missing provider breakdown to null', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  const parsed = parseDashboardQualityEnvelope(
    envelope({
      quality: {
        org: null,
        me: summary({ completedRecordings: 2 }),
      },
    })
  );

  assert.equal(parsed.quality.byProvider, null);
});

test('parseDashboardQualityEnvelope returns null quality during rollout', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  const parsed = parseDashboardQualityEnvelope({ periodDays: 30, recentRecordings: [] });

  assert.equal(JSON.stringify(parsed), JSON.stringify({ periodDays: 30, quality: null }));
});

test('parseDashboardQualityEnvelope accepts explicit null quality during rollout', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  const parsed = parseDashboardQualityEnvelope({ periodDays: 30, quality: null });

  assert.equal(JSON.stringify(parsed), JSON.stringify({ periodDays: 30, quality: null }));
});

test('parseDashboardQualityEnvelope accepts fractional average durations', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  const parsed = parseDashboardQualityEnvelope(
    envelope({
      quality: {
        org: summary({ averageRecordingLengthSeconds: 320.5 }),
        me: summary({ processingLatencyAvgSeconds: 30.5 }),
        byAppointmentType: [breakdown({ averageRecordingLengthSeconds: 120.25 })],
        byModel: [breakdown({ processingLatencyP90Seconds: 45.75 })],
        byProvider: null,
      },
    })
  );

  assert.equal(parsed.quality.org.averageRecordingLengthSeconds, 320.5);
  assert.equal(parsed.quality.me.processingLatencyAvgSeconds, 30.5);
  assert.equal(parsed.quality.byAppointmentType[0].averageRecordingLengthSeconds, 120.25);
  assert.equal(parsed.quality.byModel[0].processingLatencyP90Seconds, 45.75);
});

test('parseDashboardQualityEnvelope rejects malformed present quality', async () => {
  const { parseDashboardQualityEnvelope } = await loadQualityAnalytics();

  assert.throws(() =>
    parseDashboardQualityEnvelope(envelope({ quality: { org: { completedRecordings: -1 } } }))
  );
});

test('qualityAnalyticsApi fetches the existing dashboard endpoint', async () => {
  const calls = [];
  const { qualityAnalyticsApi } = await loadQualityAnalytics({
    async get(path) {
      calls.push(path);
      return envelope();
    },
  });

  const response = await qualityAnalyticsApi.getDashboardQuality();

  assert.equal(calls[0], '/api/organization/dashboard');
  assert.equal(response.quality.me.completedRecordings, 1);
});

test('quality analytics access includes every authenticated role after device registration', async () => {
  const { shouldFetchQualityAnalytics } = await loadQualityAnalytics();

  for (const role of ['owner', 'admin', 'veterinarian', 'support_staff']) {
    assert.equal(
      shouldFetchQualityAnalytics({ id: `${role}-id`, role }, false, false),
      true,
      `${role} should receive Clinic Quality`
    );
  }
  assert.equal(shouldFetchQualityAnalytics(null, false, false), false);
  assert.equal(
    shouldFetchQualityAnalytics({ id: 'support-id', role: 'support_staff' }, true, false),
    false
  );
  assert.equal(
    shouldFetchQualityAnalytics({ id: 'support-id', role: 'support_staff' }, false, true),
    false
  );
});

test('Home renders clinic quality after Recent Recordings and refreshes it safely', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(source, /qualityAnalyticsApi,[\s\S]*shouldFetchQualityAnalytics,[\s\S]*src\/api\/qualityAnalytics/);
  assert.match(
    source,
    /queryKey:\s*\['dashboard', 'quality', user\?\.organizationId, user\?\.id, user\?\.role\]/
  );
  // Forwards React Query's AbortSignal so a superseding refetch cancels the
  // in-flight request instead of racing it.
  assert.match(
    source,
    /queryFn:\s*\(\{ signal \}\) => qualityAnalyticsApi\.getDashboardQuality\(\{ signal \}\)/
  );
  // Every refresh path routes through the one scheduler, so a trailing timer
  // armed by a completion cannot fire on top of a manual refresh.
  assert.match(source, /runQualityRefetch\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(source, /const runQualityRefetch = useCallback\(\(\) => \{/);
  assert.match(source, /refetch=\{runQualityRefetch\}/);
  assert(
    source.indexOf('Recent Recordings') < source.indexOf('<QualityAnalyticsCard'),
    'quality card should render after Recent Recordings'
  );
});

test('Home gates all-role clinic quality only by auth and device readiness', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(
    source,
    /queryKey:\s*\['dashboard', 'quality', user\?\.organizationId, user\?\.id, user\?\.role\]/
  );
  assert.match(
    source,
    /const canFetchQualityAnalytics = shouldFetchQualityAnalytics\(\s*user,\s*deviceRegistrationPending,\s*!!deviceRegistrationBlock\s*\)/
  );
  assert.doesNotMatch(source, /canFetchQualityAnalytics\s*=.*canRecordAppointments/);
  assert.match(source, /enabled:\s*canFetchQualityAnalytics/);
  assert.match(source, /if \(canFetchQualityAnalytics\) \{\s*runQualityRefetch\(\)\.catch\(\(\) => \{\}\);\s*\}/);
  assert.match(source, /\{canFetchQualityAnalytics \? \(\s*<View className="mb-8">\s*<QualityAnalyticsCard/);
});

test('Home refreshes clinic quality when recent processing recordings leave processing', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(source, /const processingRecordingIds = useMemo\(\(\) =>/);
  assert.match(source, /const processingRecordingIdsRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(source, /const finishedProcessing = \[\.\.\.processingRecordingIdsRef\.current\]\.some/);
  // A row that simply left the top-5 window is NOT a completion. Requiring the
  // id to still be visible is what stops ordinary list churn from firing a
  // redundant /api/organization/dashboard request.
  assert.match(source, /visibleRecordingIds\.has\(id\) && !processingRecordingIds\.has\(id\)/);
  assert.match(source, /const visibleRecordingIds = useMemo\(/);
  // Batches finishing together must not stack dashboard requests.
  assert.match(source, /const QUALITY_REFETCH_MIN_INTERVAL_MS = 30_000/);
  assert.match(source, /sinceLast >= QUALITY_REFETCH_MIN_INTERVAL_MS/);
  // The scheduler stamps the throttle clock and cancels any pending trailing
  // timer before delegating to the query's own refetch.
  assert.match(source, /clearTimeout\(trailingQualityRefetchRef\.current\);\s*trailingQualityRefetchRef\.current = null;\s*\}\s*lastQualityRefetchAtRef\.current = Date\.now\(\);\s*return refetchQuality\(\);/);
  // Only the scheduler may call the raw query refetch.
  assert.equal((source.match(/refetchQuality\(\)/g) ?? []).length, 1);
  // A completion landing inside the throttle window must be DEFERRED, not
  // dropped: its id has already left processingRecordingIdsRef, so nothing else
  // would ever retry it and the summary would keep pre-completion numbers.
  assert.match(source, /const trailingQualityRefetchRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/);
  assert.match(source, /if \(trailingQualityRefetchRef\.current\) return;/);
  assert.match(source, /trailingQualityRefetchRef\.current = setTimeout\(/);
  assert.match(source, /QUALITY_REFETCH_MIN_INTERVAL_MS - sinceLast/);
  // ...and must never stay armed past unmount.
  assert.match(source, /clearTimeout\(trailingQualityRefetchRef\.current\)/);
});

test('QualityAnalyticsCard uses one Card and shows unavailable retry for missing quality', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');

  assert.equal(source.match(/<Card\b/g)?.length, 1);
  assert.match(source, /isError \|\| !quality/);
  assert.match(source, /QUALITY_ANALYTICS_COPY\.unavailable/);
  assert.match(source, /onPress=\{\(\) => \{\s*refetch\(\)\.catch\(\(\) => \{\}\);\s*\}\}/s);
  assert.match(source, /isNaN\(date\.getTime\(\)\)/);
  assert.match(source, /quality\.org\s*\?\s*hasActivity\(quality\.org\)\s*:\s*false/);
  assert.match(source, /quality\.byProvider\?\.\s*some\(hasActivity\)\s*\?\?\s*false/);
  assert.match(source, /\{quality\.org && <SummaryBlock title=\{QUALITY_ANALYTICS_COPY\.org\} summary=\{quality\.org\} \/>\}/);
  assert.match(source, /\{quality\.byProvider\?\.length \? \(/);
  assert.doesNotMatch(source, /onPress=\{async/);
});

test('QualityAnalyticsCard renders clearer labels and all-user breakdown sections', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');
  const copy = await read('src/constants/strings.ts');

  assert.match(copy, /reprocesses: 'Reprocesses'/);
  assert.match(copy, /soapEditRate: 'Edited notes'/);
  assert.match(copy, /p90Processing: '90% done by'/);
  assert.doesNotMatch(copy, /Reprocess rate|SOAP edit rate|P90 processing/);
  assert.match(copy, /appointmentTypes: 'Appointment types'/);
  assert.match(copy, /models: 'Models'/);
  assert.match(source, /function BreakdownRow/);
  assert.match(source, /quality\.byAppointmentType\?\.length/);
  assert.match(source, /quality\.byModel\?\.length/);
  assert.match(source, /item\.completedRecordings > 0/);
});

test('QualityAnalyticsCard breakdown rows do not force metric text into one clipped line', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');

  assert.doesNotMatch(source, /text-caption text-content-tertiary mr-3 mb-1" numberOfLines=\{1\}/);
  assert.doesNotMatch(source, /text-caption text-warning-500 mr-2 mb-1" numberOfLines=\{1\}/);
  assert.match(source, /<Metric label=\{QUALITY_ANALYTICS_COPY\.metrics\.averageLength\}/);
});

test('hasActivity treats every counter as activity and an all-zero summary as none', async () => {
  const { hasActivity } = await loadQualityAnalytics();

  // This drives the card's "No clinic quality data yet" gate: a false negative
  // hides a practice's real numbers behind an empty state, a false positive
  // renders an all-zero shell. Each counter is load-bearing on its own.
  const quiet = summary({
    completedRecordings: 0,
    failedUploadAttempts: 0,
    silentAudioEvents: 0,
    reprocessCount: 0,
    soapEditedCount: 0,
    missingMetadataCount: 0,
  });

  assert.equal(hasActivity(quiet), false);

  for (const field of [
    'completedRecordings',
    'failedUploadAttempts',
    'silentAudioEvents',
    'reprocessCount',
    'soapEditedCount',
    'missingMetadataCount',
  ]) {
    assert.equal(
      hasActivity({ ...quiet, [field]: 1 }),
      true,
      `${field} alone must count as activity`
    );
  }

  // Rates are not activity: a stale rate with no counts behind it must not
  // keep the empty state from showing.
  assert.equal(
    hasActivity({ ...quiet, reprocessRate: 5, soapEditRate: 1, missingMetadataRate: 1 }),
    false
  );
});

test('visibleBreakdownItems hides groups whose sample is too small to mean anything', async () => {
  const { visibleBreakdownItems, QUALITY_BREAKDOWN_MIN_RECORDINGS } = await loadQualityAnalytics();

  assert.equal(QUALITY_BREAKDOWN_MIN_RECORDINGS, 5);

  const visible = visibleBreakdownItems([
    breakdown({ key: 'a', label: 'Solid', completedRecordings: 12 }),
    cleanBreakdown({ key: 'b', label: 'gemini-3.5-flash', completedRecordings: 1 }),
    cleanBreakdown({
      key: 'c',
      label: 'Unknown model',
      completedRecordings: 0,
      averageRecordingLengthSeconds: 0,
      reprocessRate: null,
      soapEditRate: null,
      missingMetadataRate: null,
      processingLatencyAvgSeconds: null,
      processingLatencyP50Seconds: null,
      processingLatencyP90Seconds: null,
    }),
  ]);

  assert.deepEqual(
    visible.map((item) => item.key),
    ['a']
  );
});

test('visibleBreakdownItems keeps a low-completion group carrying count-based problems', async () => {
  const { visibleBreakdownItems, hasDisplayableIssueCounts } = await loadQualityAnalytics();

  // The regression this guards: gating on completedRecordings alone hid an
  // appointment type with 20 failed uploads and zero completions — the org
  // aggregate reported the failures while the breakdown naming the culprit
  // disappeared.
  const visible = visibleBreakdownItems([
    cleanBreakdown({ key: 'uploads', label: 'Wellness', completedRecordings: 0, failedUploadAttempts: 20 }),
    cleanBreakdown({ key: 'silent', label: 'Surgery', completedRecordings: 2, silentAudioEvents: 3 }),
    cleanBreakdown({ key: 'reproc', label: 'Dental', completedRecordings: 1, reprocessCount: 4 }),
    cleanBreakdown({ key: 'quiet', label: 'Exam', completedRecordings: 3 }),
  ]);

  assert.deepEqual(
    visible.map((item) => item.key).sort(),
    ['reproc', 'silent', 'uploads'],
    'groups with displayable count-based problems must survive the sample filter'
  );

  assert.equal(hasDisplayableIssueCounts(cleanBreakdown({ failedUploadAttempts: 1 })), true);
  assert.equal(hasDisplayableIssueCounts(cleanBreakdown({ silentAudioEvents: 1 })), true);
  assert.equal(hasDisplayableIssueCounts(cleanBreakdown({ reprocessCount: 1 })), true);
  assert.equal(hasDisplayableIssueCounts(cleanBreakdown({})), false);
});

test('visibleBreakdownItems retains a low-completion group awaiting metadata', async () => {
  const { visibleBreakdownItems, hasDisplayableIssueCounts } = await loadQualityAnalytics();

  // missingMetadataCount stands on its own: it counts non-draft recordings
  // pending metadata and its rate divides by nonDraftRecordingCountInWindow, not
  // completions, so four completions with many recordings awaiting details is a
  // real finding. BreakdownRow renders it as the `Awaiting details` tile.
  const awaitingMetadata = cleanBreakdown({
    key: 'meta',
    label: 'Recheck',
    completedRecordings: 4,
    missingMetadataCount: 3,
    missingMetadataRate: 0.9,
  });

  assert.equal(hasDisplayableIssueCounts(awaitingMetadata), true);
  assert.deepEqual(
    visibleBreakdownItems([awaitingMetadata]).map((item) => item.key),
    ['meta']
  );
});

test('visibleBreakdownItems does not retain a group for edited notes alone', async () => {
  const { visibleBreakdownItems, hasDisplayableIssueCounts } = await loadQualityAnalytics();

  // soapEditedCount is the one counter deliberately left out of retention: the
  // row already carries an `Edited notes` tile for it, and an edited note is
  // normal clinical work rather than a failure to surface.
  const onlyEditedNotes = cleanBreakdown({
    key: 'edits',
    label: 'Wellness',
    completedRecordings: 2,
    soapEditedCount: 2,
    soapEditRate: 0.9,
  });

  assert.equal(hasDisplayableIssueCounts(onlyEditedNotes), false);
  assert.deepEqual(visibleBreakdownItems([onlyEditedNotes]), []);
});

test('hasDisplayableIssueCounts is exactly hasActivity minus the completion counter', async () => {
  const { hasActivity, hasDisplayableIssueCounts } = await loadQualityAnalytics();

  // Round 2 of review found the row filter and the card's empty-state gate
  // disagreeing about what counts as a finding. This pins the relationship so
  // they cannot drift apart again: adding a counter to hasActivity without
  // deciding whether a breakdown row can display it fails here.
  const quiet = summary({
    completedRecordings: 0,
    failedUploadAttempts: 0,
    silentAudioEvents: 0,
    reprocessCount: 0,
    soapEditedCount: 0,
    missingMetadataCount: 0,
  });

  for (const field of [
    'completedRecordings',
    'failedUploadAttempts',
    'silentAudioEvents',
    'reprocessCount',
    'soapEditedCount',
    'missingMetadataCount',
  ]) {
    const one = { ...quiet, [field]: 1 };
    const expected =
      field === 'completedRecordings' || field === 'soapEditedCount'
        ? false
        : hasActivity(one);
    assert.equal(
      hasDisplayableIssueCounts(one),
      expected,
      `${field}: retention and the empty-state gate disagree`
    );
  }
});

test('visibleBreakdownItems keeps a group at exactly the minimum', async () => {
  const { visibleBreakdownItems } = await loadQualityAnalytics();

  const visible = visibleBreakdownItems([
    cleanBreakdown({ key: 'at-min', completedRecordings: 5 }),
    cleanBreakdown({ key: 'below-min', completedRecordings: 4 }),
  ]);

  assert.deepEqual(
    visible.map((item) => item.key),
    ['at-min']
  );
});

test('visibleBreakdownItems sorts by completed recordings desc with a label tiebreak', async () => {
  const { visibleBreakdownItems } = await loadQualityAnalytics();

  const visible = visibleBreakdownItems([
    breakdown({ key: 'mid', label: 'Mid', completedRecordings: 20 }),
    breakdown({ key: 'tie-b', label: 'Beta', completedRecordings: 50 }),
    breakdown({ key: 'tie-a', label: 'Alpha', completedRecordings: 50 }),
    breakdown({ key: 'small', label: 'Small', completedRecordings: 6 }),
  ]);

  assert.deepEqual(
    visible.map((item) => item.key),
    ['tie-a', 'tie-b', 'mid', 'small']
  );
});

test('visibleBreakdownItems caps the list and never mutates its argument', async () => {
  const { visibleBreakdownItems, QUALITY_BREAKDOWN_MAX_ROWS } = await loadQualityAnalytics();

  assert.equal(QUALITY_BREAKDOWN_MAX_ROWS, 5);

  const input = [
    breakdown({ key: 'k1', label: 'One', completedRecordings: 10 }),
    breakdown({ key: 'k2', label: 'Two', completedRecordings: 90 }),
    breakdown({ key: 'k3', label: 'Three', completedRecordings: 20 }),
    breakdown({ key: 'k4', label: 'Four', completedRecordings: 80 }),
    breakdown({ key: 'k5', label: 'Five', completedRecordings: 30 }),
    breakdown({ key: 'k6', label: 'Six', completedRecordings: 70 }),
    breakdown({ key: 'k7', label: 'Seven', completedRecordings: 40 }),
  ];
  const inputOrder = input.map((item) => item.key);

  const visible = visibleBreakdownItems(input);

  assert.equal(visible.length, QUALITY_BREAKDOWN_MAX_ROWS);
  assert.deepEqual(
    visible.map((item) => item.key),
    ['k2', 'k4', 'k6', 'k7', 'k5']
  );
  assert.deepEqual(
    input.map((item) => item.key),
    inputOrder,
    'visibleBreakdownItems must not sort the caller array in place'
  );
});

test('visibleBreakdownItems returns an empty list when no group clears the minimum', async () => {
  const { visibleBreakdownItems } = await loadQualityAnalytics();

  assert.deepEqual(
    visibleBreakdownItems([
      cleanBreakdown({ key: 'a', completedRecordings: 4 }),
      cleanBreakdown({ key: 'b', completedRecordings: 1 }),
    ]),
    []
  );
  assert.deepEqual(visibleBreakdownItems([]), []);
});

test('breakdownIssueAlerts states the missing-details number, not a bare label', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  const alerts = breakdownIssueAlerts(
    summary({
      completedRecordings: 8,
      missingMetadataRate: 0.4,
      missingMetadataCount: 3,
      reprocessRate: 0.1,
    })
  );

  assert.deepEqual(plain(alerts), [{ kind: 'missingDetails', pct: 40 }]);
});

test('breakdownIssueAlerts reports reprocessing as counts so >100% never renders', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  const alerts = breakdownIssueAlerts(
    summary({
      reprocessRate: 1.2,
      reprocessCount: 6,
      completedRecordings: 5,
      missingMetadataRate: 0.1,
    })
  );

  assert.deepEqual(plain(alerts), [{ kind: 'reprocessed', count: 6 }]);
  assert.equal('pct' in alerts[0], false, 'reprocessing must never be expressed as a percentage');
  // No denominator: reprocessCount counts audit-log actions in the window, which
  // may target recordings created before it, so relating it to completedRecordings
  // claimed a relationship that does not hold.
  assert.equal(
    'recordings' in alerts[0],
    false,
    'reprocessing must not report completions as the reprocessed recording set'
  );
});

test('breakdownIssueAlerts stays silent below every threshold', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
          completedRecordings: 8,
          missingMetadataRate: 0.19,
          reprocessRate: 0.19,
          soapEditRate: 0.49,
        })
      )
    ),
    []
  );
});

test('breakdownIssueAlerts treats null rates as no signal', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
          completedRecordings: 8,
          missingMetadataRate: null,
          reprocessRate: null,
          soapEditRate: null,
        })
      )
    ),
    []
  );
});

test('breakdownIssueAlerts caps at two alerts, keeping missing details and reprocessing', async () => {
  const { breakdownIssueAlerts, QUALITY_BREAKDOWN_MAX_ALERTS } = await loadQualityAnalytics();

  assert.equal(QUALITY_BREAKDOWN_MAX_ALERTS, 2);

  const alerts = breakdownIssueAlerts(
    summary({
      completedRecordings: 9,
      missingMetadataRate: 0.4,
      reprocessRate: 0.5,
      soapEditRate: 0.9,
    })
  );

  assert.deepEqual(plain(alerts), [
    { kind: 'missingDetails', pct: 40 },
    { kind: 'reprocessed', count: 2 },
  ]);
});

test('breakdownIssueAlerts suppresses rate alerts below the sample minimum but keeps counts', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  // A group retained on count-based problems alone must not assert a percentage
  // off one or two recordings. Counts stay — "6 reprocesses" is true at any
  // sample size.
  const tinySample = {
    completedRecordings: 2,
    missingMetadataRate: 0.9,
    missingMetadataCount: 2,
    soapEditRate: 0.9,
    soapEditedCount: 2,
    reprocessRate: 3,
    reprocessCount: 6,
  };

  assert.deepEqual(plain(breakdownIssueAlerts(summary(tinySample))), [
    { kind: 'reprocessed', count: 6 },
  ]);

  // The same rates at an adequate sample do produce their alerts, so the gate
  // is the sample size and nothing else.
  assert.deepEqual(
    plain(breakdownIssueAlerts(summary({ ...tinySample, completedRecordings: 5 }))).map(
      (alert) => alert.kind
    ),
    ['missingDetails', 'reprocessed']
  );
});

test('breakdownIssueAlerts requires a non-zero numerator for every alert', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
          completedRecordings: 8,
          missingMetadataRate: 0.4,
          missingMetadataCount: 0,
          reprocessRate: 0.1,
        })
      )
    ),
    []
  );
  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
          completedRecordings: 8,
          soapEditRate: 0.9,
          soapEditedCount: 0,
          missingMetadataRate: 0.1,
          reprocessRate: 0.1,
        })
      )
    ),
    []
  );
  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
          completedRecordings: 8,
          reprocessRate: 0.5,
          reprocessCount: 0,
          missingMetadataRate: 0.1,
        })
      )
    ),
    []
  );
  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
          reprocessRate: 0.5,
          reprocessCount: 3,
          completedRecordings: 0,
          missingMetadataRate: 0.1,
        })
      )
    ),
    [],
    'a zero-recording group must not claim "Reprocessed 3 times across 0 recordings"'
  );
});

test('QualityAnalyticsCard renders each breakdown alert as one wrapping sentence', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');
  const copy = await read('src/constants/strings.ts');

  // The clip fix: a width-constrained Text, no numberOfLines on it, and an
  // icon wrapper that cannot shrink. The old flex-wrap badge bag is gone.
  assert.match(source, /className="text-caption text-status-warning flex-1"/);
  assert.doesNotMatch(source, /text-caption text-status-warning flex-1"\s+numberOfLines/);
  assert.match(source, /style=\{\{ flexShrink: 0 \}\}/);
  assert.doesNotMatch(source, /flex-row flex-wrap mt-1/);
  assert.match(source, /colors\.statusWarningFg/);

  // Alert copy lives in the catalog and carries the number.
  assert.match(copy, /missingDetails: '\{pct\}% missing patient details'/);
  assert.match(copy, /soapEdited: '\{pct\}% of notes edited'/);
  assert.match(copy, /reprocessedOnce: 'Reprocessed once'/);
  assert.match(copy, /reprocessedMany: 'Reprocessed \{count\} times'/);
  // The denominator must not come back without a server field for distinct
  // recordings reprocessed.
  assert.doesNotMatch(copy, /Reprocessed[^']*\{recordings\}/);
  assert.match(copy, /unlabeledGroup: 'Not specified'/);
});

test('QualityAnalyticsCard fills every placeholder the alert templates declare', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');
  const copy = await read('src/constants/strings.ts');

  // Derive the placeholder set from the shipped catalog rather than restating
  // it, then require the card to fill each one. Without this, a renamed
  // placeholder on either side (or a dropped .replace) ships the raw template
  // text — "{pct}% missing patient details" — with no test or typecheck signal.
  const issuesBlock = copy.match(/issues: \{([\s\S]*?)\n {2}\},/);
  assert.ok(issuesBlock, 'QUALITY_ANALYTICS_COPY.issues block not found');
  const placeholders = [
    ...new Set([...issuesBlock[1].matchAll(/\{(\w+)\}/g)].map((match) => match[1])),
  ].sort();

  // A new placeholder in the catalog must come with a fill below.
  assert.deepEqual(placeholders, ['count', 'pct']);

  // Pin each switch branch whole. A per-placeholder "appears somewhere in the
  // file" search is NOT enough: breaking {pct} in the missingDetails branch
  // still matches the soapEdited branch's own {pct} fill (verified by mutating
  // one branch and watching a looser version of this test stay green).
  assert.match(
    source,
    /case 'missingDetails':\s*return c\.missingDetails\.replace\('\{pct\}', String\(alert\.pct\)\);/
  );
  assert.match(
    source,
    /case 'soapEdited':\s*return c\.soapEdited\.replace\('\{pct\}', String\(alert\.pct\)\);/
  );
  assert.match(
    source,
    /case 'reprocessed':\s*return \(alert\.count === 1 \? c\.reprocessedOnce : c\.reprocessedMany\)\.replace\(\s*'\{count\}',\s*String\(alert\.count\)\s*\);/
  );
});

test('QualityAnalyticsCard reports reprocessing as a count everywhere, never a rate', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');
  const copy = await read('src/constants/strings.ts');

  // reprocessRate is unbounded (several reprocess actions per recording), so a
  // '200%' tile above a count-based alert read as a rendering fault. Both the
  // SummaryBlock and BreakdownRow tiles show the raw count.
  assert.match(source, /<Metric label=\{c\.reprocesses\} value=\{summary\.reprocessCount\} \/>/);
  assert.match(
    source,
    /<Metric label=\{QUALITY_ANALYTICS_COPY\.metrics\.reprocesses\} value=\{item\.reprocessCount\} \/>/
  );
  assert.doesNotMatch(source, /formatRate\(summary\.reprocessRate\)/);
  assert.doesNotMatch(source, /formatRate\(item\.reprocessRate\)/);

  // A group kept purely on count-based problems needs a tile for each of them,
  // or the retained row renders as the empty "0 rec / n/a everywhere" shell.
  assert.match(
    source,
    /<Metric label=\{QUALITY_ANALYTICS_COPY\.metrics\.uploadIssues\} value=\{item\.failedUploadAttempts\} \/>/
  );
  assert.match(
    source,
    /<Metric label=\{QUALITY_ANALYTICS_COPY\.metrics\.silentAudio\} value=\{item\.silentAudioEvents\} \/>/
  );
  assert.match(
    source,
    /<Metric label=\{QUALITY_ANALYTICS_COPY\.metrics\.missingDetailsCount\} value=\{item\.missingMetadataCount\} \/>/
  );
  // The count tile must not reuse the rate label: `missingDetails` is a
  // percentage in SummaryBlock.
  assert.match(copy, /missingDetailsCount: 'Awaiting details'/);
  assert.doesNotMatch(
    source,
    /<Metric label=\{QUALITY_ANALYTICS_COPY\.metrics\.missingDetails\} value=\{item\./
  );

  // The catalog must not carry a rate-shaped reprocess label again.
  assert.doesNotMatch(copy, /reprocessRate:/);

  // The two genuinely bounded rates still render as percentages.
  assert.match(source, /formatRate\(summary\.soapEditRate\)/);
  assert.match(source, /formatRate\(summary\.missingMetadataRate\)/);
});

test('QualityAnalyticsCard wires the shared derivation helpers instead of local copies', async () => {
  const source = await read('src/components/QualityAnalyticsCard.tsx');

  assert.match(source, /visibleBreakdownItems\(items\)/);
  assert.doesNotMatch(source, /items\.slice\(0, 5\)/);
  assert.match(source, /breakdownIssueAlerts\(item\)/);
  assert.doesNotMatch(source, /function issueLabels/);
  assert.doesNotMatch(source, /function hasActivity/);
  assert.match(source, /item\.label\.trim\(\) \|\| QUALITY_ANALYTICS_COPY\.unlabeledGroup/);
  assert.doesNotMatch(source, /Clock3/);
  assert.match(source, /quality\.byProvider\.slice\(0, 5\)\.map/);
});
