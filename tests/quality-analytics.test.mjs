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
  assert.match(source, /queryFn:\s*\(\) => qualityAnalyticsApi\.getDashboardQuality\(\)/);
  assert.match(source, /refetchQuality\(\)\.catch\(\(\) => \{\}\)/);
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
  assert.match(source, /if \(canFetchQualityAnalytics\) \{\s*refetchQuality\(\)\.catch\(\(\) => \{\}\);\s*\}/);
  assert.match(source, /\{canFetchQualityAnalytics \? \(\s*<View className="mb-8">\s*<QualityAnalyticsCard/);
});

test('Home refreshes clinic quality when recent processing recordings leave processing', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(source, /const processingRecordingIds = useMemo\(\(\) =>/);
  assert.match(source, /const processingRecordingIdsRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(source, /const completedProcessing = \[\.\.\.processingRecordingIdsRef\.current\]\.some/);
  assert.match(source, /if \(canFetchQualityAnalytics && completedProcessing\) \{\s*refetchQuality\(\)\.catch\(\(\) => \{\}\);\s*\}/);
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

test('visibleBreakdownItems hides groups whose sample is too small to mean anything', async () => {
  const { visibleBreakdownItems, QUALITY_BREAKDOWN_MIN_RECORDINGS } = await loadQualityAnalytics();

  assert.equal(QUALITY_BREAKDOWN_MIN_RECORDINGS, 5);

  const visible = visibleBreakdownItems([
    breakdown({ key: 'a', label: 'Solid', completedRecordings: 12 }),
    breakdown({ key: 'b', label: 'gemini-3.5-flash', completedRecordings: 1 }),
    breakdown({
      key: 'c',
      label: 'Unknown model',
      ...summary({
        completedRecordings: 0,
        averageRecordingLengthSeconds: 0,
        failedUploadAttempts: 0,
        reprocessCount: 0,
        reprocessRate: null,
        soapEditedCount: 0,
        soapEditRate: null,
        missingMetadataCount: 0,
        missingMetadataRate: null,
        processingLatencyAvgSeconds: null,
        processingLatencyP50Seconds: null,
        processingLatencyP90Seconds: null,
      }),
    }),
  ]);

  assert.deepEqual(
    visible.map((item) => item.key),
    ['a']
  );
});

test('visibleBreakdownItems keeps a group at exactly the minimum', async () => {
  const { visibleBreakdownItems } = await loadQualityAnalytics();

  const visible = visibleBreakdownItems([
    breakdown({ key: 'at-min', completedRecordings: 5 }),
    breakdown({ key: 'below-min', completedRecordings: 4 }),
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
      breakdown({ key: 'a', completedRecordings: 4 }),
      breakdown({ key: 'b', completedRecordings: 1 }),
    ]),
    []
  );
  assert.deepEqual(visibleBreakdownItems([]), []);
});

test('breakdownIssueAlerts states the missing-details number, not a bare label', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  const alerts = breakdownIssueAlerts(
    summary({ missingMetadataRate: 0.4, missingMetadataCount: 3, reprocessRate: 0.1 })
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

  assert.deepEqual(plain(alerts), [{ kind: 'reprocessed', count: 6, recordings: 5 }]);
  assert.equal('pct' in alerts[0], false, 'reprocessing must never be expressed as a percentage');
});

test('breakdownIssueAlerts stays silent below every threshold', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({ missingMetadataRate: 0.19, reprocessRate: 0.19, soapEditRate: 0.49 })
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
        summary({ missingMetadataRate: null, reprocessRate: null, soapEditRate: null })
      )
    ),
    []
  );
});

test('breakdownIssueAlerts caps at two alerts, keeping missing details and reprocessing', async () => {
  const { breakdownIssueAlerts, QUALITY_BREAKDOWN_MAX_ALERTS } = await loadQualityAnalytics();

  assert.equal(QUALITY_BREAKDOWN_MAX_ALERTS, 2);

  const alerts = breakdownIssueAlerts(
    summary({ missingMetadataRate: 0.4, reprocessRate: 0.5, soapEditRate: 0.9 })
  );

  assert.deepEqual(plain(alerts), [
    { kind: 'missingDetails', pct: 40 },
    { kind: 'reprocessed', count: 2, recordings: 4 },
  ]);
});

test('breakdownIssueAlerts requires a non-zero numerator for every alert', async () => {
  const { breakdownIssueAlerts } = await loadQualityAnalytics();

  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({ missingMetadataRate: 0.4, missingMetadataCount: 0, reprocessRate: 0.1 })
      )
    ),
    []
  );
  assert.deepEqual(
    plain(
      breakdownIssueAlerts(
        summary({
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
        summary({ reprocessRate: 0.5, reprocessCount: 0, missingMetadataRate: 0.1 })
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
  assert.match(copy, /reprocessedOnce: 'Reprocessed once across \{recordings\} recordings'/);
  assert.match(copy, /reprocessedMany: 'Reprocessed \{count\} times across \{recordings\} recordings'/);
  assert.match(copy, /unlabeledGroup: 'Not specified'/);
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
