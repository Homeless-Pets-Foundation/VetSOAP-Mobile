import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { loadTsModule } from './helpers/loadTs.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const strings = await loadTsModule('src/constants/strings.ts');
const history = await loadTsModule('src/lib/recordingHistory.ts');
const dates = await loadTsModule('src/lib/recordingDateGroups.ts');
const drafts = await loadTsModule('src/lib/draftRecordings.ts', { './fileOps': { fileExists: () => true } });
const location = await loadTsModule('src/lib/draftLocation.ts');
const permissions = await loadTsModule('src/lib/recordingPermissions.ts');
const display = await loadTsModule('src/lib/recordingDisplay.ts');

function nodes(value, predicate) {
  if (Array.isArray(value)) return value.flatMap((child) => nodes(child, predicate));
  if (!value || typeof value !== 'object') return [];
  return [...(value.type && predicate(value) ? [value] : []),
    ...Object.values(value.props ?? {}).flatMap((child) => nodes(child, predicate))];
}

async function screenHarness({ regular = [], serverDrafts = [], localDrafts = [], params = {} } = {}) {
  const hooks = [];
  const timers = new Map();
  const states = new Map();
  const configs = {};
  const active = {};
  const calls = [];
  const pending = [];
  let cursor = 0;
  let effects = [];
  let changed = false;
  let focused = true;
  let user = { id: 'user-a', organizationId: 'org-a', role: 'veterinarian' };
  let tree;
  let tabBlur;
  let timerId = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => {
        const value = typeof next === 'function' ? next(hooks[index]) : next;
        if (!Object.is(hooks[index], value)) { hooks[index] = value; changed = true; }
      }];
    },
    useRef: (value) => react.useState(() => ({ current: value }))[0],
    useMemo(compute, dependencies) {
      const index = cursor++;
      if (!hooks[index] || dependencies.some((value, i) => !Object.is(value, hooks[index].dependencies[i]))) {
        hooks[index] = { dependencies, value: compute() };
      }
      return hooks[index].value;
    },
    useCallback: (callback, dependencies) => react.useMemo(() => callback, dependencies),
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        hooks[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.(); hooks[index].cleanup = callback(); });
      }
    },
  };
  const router = { push() {}, setParams: (next) => Object.assign(params, next) };
  const navigation = { getParent: () => ({ addListener: (_, callback) => { tabBlur = callback; return () => {}; } }) };
  const local = {
    localDrafts, draftResumeMap: drafts.buildDraftResumeMap(localDrafts), savedSessionDraftMap: {},
    isLoading: false, isError: false, isStale: false, refreshLocalDrafts() {},
  };
  async function listApi(options) {
    calls.push(options);
    const source = options.status === 'draft' ? serverDrafts : regular;
    const rows = source.filter((row) =>
      (!options.status || row.status === options.status) &&
      history.matchesActivityRange(row, options) &&
      (!options.search || [row.patientName, row.clientName, row.pimsPatientId].some((value) => value?.includes(options.search)))
    );
    const sorted = drafts.sortRecordingsBySubmittedAt(rows, options.sortOrder);
    const offset = (options.page - 1) * options.limit;
    return { data: sorted.slice(offset, offset + options.limit), pagination: {
      page: options.page, totalPages: Math.max(1, Math.ceil(sorted.length / options.limit)), total: sorted.length,
    } };
  }
  function useInfiniteQuery(config) {
    const source = config.queryKey[1] === 'drafts' ? 'drafts' : 'regular';
    const key = JSON.stringify(config.queryKey);
    if (!states.has(key)) {
      const state = { data: undefined, isLoading: false, isError: false, isStale: false,
        isRefetching: false, isFetchingNextPage: false, hasNextPage: false, error: null };
      state.refetch = async () => {};
      state.fetchNextPage = () => {
        const next = state.data ? configs[source].getNextPageParam(state.data.pages.at(-1)) : 1;
        if (next === undefined) return Promise.resolve();
        const job = load(source, next);
        pending.push(job);
        return job;
      };
      states.set(key, state);
    }
    configs[source] = config;
    active[source] = states.get(key);
    return active[source];
  }
  async function load(source, page = 1, signal = new AbortController().signal) {
    const state = active[source];
    const result = await configs[source].queryFn({ pageParam: page, signal });
    state.data = { pages: page === 1 ? [result] : [...state.data.pages, result] };
    state.hasNextPage = configs[source].getNextPageParam(result) !== undefined;
    return result;
  }
  const modules = {
    'react': react,
    'react-native': { View: 'View', SectionList: 'SectionList', Pressable: 'Pressable',
      TextInput: 'TextInput', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'android' }, Alert: {} },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useRouter: () => router, useNavigation: () => navigation, useLocalSearchParams: () => params },
    '@react-navigation/native': { useIsFocused: () => focused,
      useFocusEffect: (callback) => react.useEffect(() => focused ? callback() : undefined, [focused, callback]) },
    '@tanstack/react-query': { useInfiniteQuery, useQueries: ({ queries }) => queries.map((query) => ({
      data: regular.find((row) => row.id === query.queryKey[1]),
    })) },
    'lucide-react-native': {}, 'expo-haptics': {},
    'components/RecordingDatesSheet': { RecordingDatesSheet: 'RecordingDatesSheet' },
    'components/ui/Button': { Button: 'Button' }, 'components/ui/Text': { Text: 'Text', TextInput: 'TextInput' },
    'api/recordings': { recordingsApi: { list: listApi } }, 'lib/recordingHistory': history,
    'lib/draftRecordings': drafts, 'lib/draftLocation': location, 'lib/recordingPermissions': permissions,
    'hooks/useAuth': { useAuthUser: () => user, useAuthDeviceRegistration: () => ({}) },
    'hooks/useLocalDraftRecordings': { useLocalDraftRecordings: () => local },
    'hooks/useRetryableInitialLoadError': { useRetryableInitialLoadError() {} },
    'hooks/useResponsive': { useResponsive: () => ({ iconSm: 20, iconLg: 48 }) },
    'hooks/useThemeColors': { useThemeColors: () => ({}) },
    'components/ui/ScreenContainer': { CONTENT_MAX_WIDTH: 600 },
    'components/RecordingCard': { RecordingCard: 'RecordingCard' },
    'components/ui/Skeleton': { SkeletonCard: 'SkeletonCard' }, 'components/ui/EmptyState': { EmptyState: 'EmptyState' },
    'components/ui/Select': { Select: 'Select' }, 'lib/recordingDisplay': display,
    'lib/recordingDateGroups': dates, 'components/StatusBadge': { StatusBadge: 'StatusBadge' },
    'constants/strings': strings, 'lib/queryPersistence': { PERSIST_GC_TIME_MS: 604_800_000 },
    'lib/monitoring': { measurePhase: (_, __, callback) => Promise.resolve(callback()) },
    'components/ui/styles': { CLIP_SAFE: {}, clipSafe: (value) => value },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(await read('app/(app)/(tabs)/recordings/index.tsx'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 0, clearInterval() {},
    require: (specifier) => {
      const name = specifier.replace('../../../../src/', '');
      assert.ok(name in modules, `Unexpected dependency ${specifier}`);
      return modules[name];
    },
  });
  function render() {
    let count = 0;
    do {
      changed = false; cursor = 0; effects = [];
      tree = module.exports.default();
      for (const effect of effects) effect();
      assert.ok(++count < 15, 'render should settle');
    } while (changed);
    return tree;
  }
  render();
  return {
    render, configs, active, calls, local, load,
    find: (type) => nodes(tree, (node) => node.type === type)[0],
    list: () => nodes(tree, (node) => node.type === 'SectionList')[0],
    controls: () => nodes(tree, (node) => node.type === 'Select'),
    alerts: () => nodes(tree, (node) => node.props.accessibilityRole === 'alert'),
    async more() { nodes(tree, (node) => node.type === 'SectionList')[0].props.onEndReached(); await Promise.all(pending.splice(0)); render(); },
    focus(value) { focused = value; render(); },
    switchUser(id) { user = { ...user, id }; render(); },
    blurTab() { tabBlur?.(); render(); },
    debounce() { for (const callback of timers.values()) callback(); timers.clear(); render(); },
  };
}

const recording = (id, status, day) => ({ id, status, patientName: 'Synthetic patient', clientName: 'Fixture',
  createdAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`, submittedAt: null, pimsPatientId: 'P-42' });
const rows = (prefix, status, count) => Array.from({ length: count }, (_, i) => recording(`${prefix}-${String(i).padStart(2, '0')}`, status, i % 25 + 1));

test('both history sources paginate beyond two pages and preserve ordering in either direction', async () => {
  for (const direction of ['asc', 'desc']) {
    const h = await screenHarness({ regular: rows('r', 'completed', 46), serverDrafts: rows('d', 'draft', 47) });
    h.controls().find((node) => node.props.accessibilityLabel === 'Order recordings').props.onValueChange(direction);
    h.render();
    await Promise.all([h.load('regular'), h.load('drafts')]); h.render();
    await h.more(); await h.more();
    assert.equal(h.calls.filter((call) => call.status === 'draft').length, 3);
    assert.equal(h.calls.filter((call) => call.status !== 'draft').length, 3);
    assert.equal(h.active.regular.hasNextPage, false);
    assert.equal(h.active.drafts.hasNextPage, false);
    const actual = h.list().props.sections.flatMap((section) => section.data);
    assert.equal(actual.length, 93);
    const expected = plain(actual).sort((a, b) => (
      (Date.parse(a.submittedAt ?? a.createdAt) - Date.parse(b.submittedAt ?? b.createdAt)) * (direction === 'asc' ? 1 : -1)
    ) || a.id.localeCompare(b.id));
    assert.deepEqual(plain(actual.map((row) => row.id)), expected.map((row) => row.id));
    assert.ok(h.calls.every((call) => call.sortBy === 'activityAt' && call.sortOrder === direction));
  }
});

test('range/search/status queries forward complete filters, page, and cancellation signal', async () => {
  const h = await screenHarness();
  const range = { preset: 'custom', from: '2026-10-05', through: '2026-10-08' };
  h.find('RecordingDatesSheet').props.onApply(range); h.render();
  h.find('TextInput').props.onChangeText('P-42'); h.render(); h.debounce();
  const controller = new AbortController();
  await h.load('regular', 1, controller.signal); await h.load('drafts', 1, controller.signal);
  for (const call of h.calls) {
    assert.equal(call.signal, controller.signal);
    assert.equal(call.search, 'P-42');
    assert.equal(call.page, 1);
    assert.equal(call.activityFrom, history.activityBounds(range, 0).activityFrom);
    assert.equal(call.activityBefore, history.activityBounds(range, 0).activityBefore);
  }
  h.controls().find((node) => node.props.sheetTitle === 'Filter by status').props.onValueChange('completed'); h.render();
  assert.equal(h.configs.drafts.enabled, false);
  assert.equal(h.configs.regular.queryKey[3], 'completed');
  assert.ok(h.configs.regular.queryKey.includes(h.calls[0].activityFrom));
  controller.abort();
  assert.equal(h.calls[0].signal.aborted, true);
});

test('local/server identity deduplication preserves draft resume routing and date filtering', async () => {
  const local = { slotId: 'slot-a', serverDraftId: 'server-a', savedAt: '2026-10-06T12:00:00Z',
    formData: { patientName: 'Local name' }, segments: [{ uri: 'file:///synthetic.m4a', duration: 1 }], audioDuration: 1 };
  const h = await screenHarness({ localDrafts: [local, { ...local, slotId: 'slot-b', serverDraftId: null, savedAt: '2026-09-01T12:00:00Z' }],
    serverDrafts: [recording('server-a', 'draft', 6)] });
  h.find('RecordingDatesSheet').props.onApply({ preset: 'custom', from: '2026-10-05', through: '2026-10-08' }); h.render();
  await h.load('drafts'); h.render();
  const actual = h.list().props.sections.flatMap((section) => section.data);
  assert.equal(actual.length, 1);
  assert.equal(actual[0].id, 'server-a');
  assert.equal(actual[0].patientName, 'Synthetic patient');
  assert.equal(h.list().props.renderItem({ item: actual[0] }).props.localDraftSlotId, 'slot-a');
});

test('user-selected history filters survive detail focus and reset on account change', async () => {
  const h = await screenHarness();
  h.controls().find((node) => node.props.sheetTitle === 'Filter by status').props.onValueChange('draft');
  h.controls().find((node) => node.props.accessibilityLabel === 'Order recordings').props.onValueChange('asc');
  h.find('RecordingDatesSheet').props.onApply({ preset: 'yesterday' }); h.render();
  const key = JSON.stringify(h.configs.drafts.queryKey);
  h.focus(false); h.focus(true);
  assert.equal(JSON.stringify(h.configs.drafts.queryKey), key);
  h.blurTab();
  assert.equal(h.configs.regular.enabled, false, 'manual status selection survives tab blur');
  h.switchUser('user-b');
  assert.equal(h.configs.regular.enabled, true);
  assert.equal(h.configs.regular.queryKey[4], 'activityAt-desc');
  assert.equal(h.configs.regular.queryKey[5], undefined);
  assert.equal(h.configs.regular.queryKey.at(-1), 'user-b');
  assert.equal(h.find('RecordingDatesSheet').props.value.preset, 'all');
});

test('one-shot draft links clear on tab blur while source failures stay visible', async () => {
  const linked = await screenHarness({ params: { status: 'draft' } });
  assert.equal(linked.configs.regular.enabled, false);
  linked.focus(false); linked.focus(true);
  assert.equal(linked.configs.regular.enabled, false, 'detail navigation retains the link filter');
  linked.blurTab();
  assert.equal(linked.configs.regular.enabled, true);
  const h = await screenHarness({ serverDrafts: [recording('draft-a', 'draft', 6)] });
  await h.load('drafts');
  h.active.regular.isError = true;
  h.active.regular.error = Object.assign(new Error('Unsupported activityAt sort'), { status: 400 });
  h.render();
  assert.equal(h.alerts().length, 1);
  assert.equal(h.list().props.sections.flatMap((section) => section.data).length, 1);
  h.active.drafts.data = undefined; h.render();
  assert.equal(h.list().props.ListEmptyComponent.props.description, strings.RECORDING_HISTORY_COPY.unavailable);
  assert.equal(h.calls.length, 1, 'an unavailable API never triggers an unfiltered request');
});

test('matching submitted rows have their own section and never duplicate ordinary date groups', async () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const h = await screenHarness({ params: { submittedIds: id }, regular: [recording(id, 'completed', 6), recording('ordinary', 'completed', 7)] });
  h.find('RecordingDatesSheet').props.onApply({ preset: 'custom', from: '2026-10-05', through: '2026-10-08' }); h.render();
  await h.load('regular'); h.render();
  assert.equal(h.list().props.sections[0].key, 'just_submitted');
  assert.equal(h.list().props.sections[0].data[0].id, id);
  assert.equal(h.list().props.sections.flatMap((section) => section.data).filter((row) => row.id === id).length, 1);
  h.find('RecordingDatesSheet').props.onApply({ preset: 'custom', from: '2026-10-07', through: '2026-10-08' }); h.render();
  await h.load('regular'); h.render();
  assert.equal(h.list().props.sections.some((section) => section.key === 'just_submitted'), false, 'a highlighted detail result must still match the range');
});

test('pending or unreadable local/server sources cannot produce an authoritative empty state', async () => {
  const h = await screenHarness();
  h.active.regular.isLoading = true; h.render();
  assert.notEqual(h.list().props.ListEmptyComponent.type, 'EmptyState');
  h.active.regular.isLoading = false; h.local.isLoading = true; h.render();
  assert.notEqual(h.list().props.ListEmptyComponent.type, 'EmptyState');
  h.local.isLoading = false; h.local.isError = true; h.render();
  assert.equal(h.list().props.ListEmptyComponent.props.description, strings.RECORDING_HISTORY_COPY.unavailable);
});

test('persistence keeps only the default history variant and retires outgoing account restores', async () => {
  const captures = [];
  const storageKeys = [];
  const reads = new Map();
  const persistence = await loadTsModule('src/lib/queryPersistence.ts', {
    '@react-native-async-storage/async-storage': {}, './queryClient': { queryClient: {} },
    'expo-application': { nativeApplicationVersion: 'synthetic-test' },
    '@tanstack/query-async-storage-persister': { createAsyncStoragePersister: ({ key }) => {
      storageKeys.push(key);
      return { persistClient: async () => {}, removeClient: async () => {},
        restoreClient: () => new Promise((resolve) => reads.set(key, resolve)) };
    } },
    '@tanstack/react-query-persist-client': { persistQueryClient: (options) => {
      captures.push(options); return [() => {}, Promise.resolve()];
    } },
  });
  persistence.startQueryPersistence('user-a');
  const shouldPersist = captures[0].dehydrateOptions.shouldDehydrateQuery;
  const check = (key) => shouldPersist({ queryKey: key, state: { data: {}, status: 'success', dataUpdatedAt: Date.now() } });
  assert.equal(check(['recordings', 'list', '', 'all', 'activityAt-desc', undefined, undefined, 'user-a']), true);
  assert.equal(check(['recordings', 'drafts', 'list', '', 'activityAt-desc', undefined, undefined, 'user-a']), true);
  for (const key of [
    ['recordings', 'list', 'search', 'all', 'activityAt-desc'],
    ['recordings', 'list', '', 'completed', 'activityAt-desc'],
    ['recordings', 'list', '', 'all', 'activityAt-asc'],
    ['recordings', 'list', '', 'all', 'activityAt-desc', '2026-10-05T00:00:00Z', '2026-10-09T00:00:00Z'],
    ['recordings', 'drafts', 'list', '', 'activityAt-asc'],
  ]) assert.equal(check(key), false);
  const outgoing = captures[0].persister.restoreClient();
  persistence.startQueryPersistence('user-b');
  const incoming = captures[1].persister.restoreClient();
  reads.get('captivet_rq_cache_user-a')({ clientState: 'outgoing' });
  reads.get('captivet_rq_cache_user-b')({ clientState: 'incoming' });
  assert.equal(await outgoing, undefined);
  assert.deepEqual(await incoming, { clientState: 'incoming' });
  assert.deepEqual(storageKeys, ['captivet_rq_cache_user-a', 'captivet_rq_cache_user-b']);
  persistence.stopQueryPersistence({ removeStored: false });
});
