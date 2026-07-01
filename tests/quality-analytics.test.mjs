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

test('Home renders clinic quality after Recent Recordings and refreshes it safely', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(source, /import \{ qualityAnalyticsApi \} from ['"].*src\/api\/qualityAnalytics['"]/);
  assert.match(source, /queryKey:\s*\['dashboard', 'quality', user\?\.organizationId\]/);
  assert.match(source, /queryFn:\s*\(\) => qualityAnalyticsApi\.getDashboardQuality\(\)/);
  assert.match(source, /refetchQuality\(\)\.catch\(\(\) => \{\}\)/);
  assert(
    source.indexOf('Recent Recordings') < source.indexOf('<QualityAnalyticsCard'),
    'quality card should render after Recent Recordings'
  );
});

test('Home gates clinic quality fetch, manual refetch, and render by recording role', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(source, /const canViewQualityAnalytics = canRecordAppointments\(user\?\.role\)/);
  assert.match(source, /enabled:\s*!!user && canViewQualityAnalytics/);
  assert.match(source, /if \(canViewQualityAnalytics\) \{\s*refetchQuality\(\)\.catch\(\(\) => \{\}\);\s*\}/);
  assert.match(source, /\{canViewQualityAnalytics \? \(\s*<View className="mb-8">\s*<QualityAnalyticsCard/);
});

test('Home refreshes clinic quality when recent processing recordings leave processing', async () => {
  const source = await read('app/(app)/(tabs)/index.tsx');

  assert.match(source, /const processingRecordingIds = useMemo\(\(\) =>/);
  assert.match(source, /const processingRecordingIdsRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(source, /const completedProcessing = \[\.\.\.processingRecordingIdsRef\.current\]\.some/);
  assert.match(source, /if \(canViewQualityAnalytics && completedProcessing\) \{\s*refetchQuality\(\)\.catch\(\(\) => \{\}\);\s*\}/);
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

  assert.match(copy, /reprocessRate: 'Reprocessed'/);
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
