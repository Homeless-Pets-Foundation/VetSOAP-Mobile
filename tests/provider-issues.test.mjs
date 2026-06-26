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

async function loadProviderIssuesApi(apiClient) {
  const source = await read('src/api/providerIssues.ts');
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
  return module.exports.providerIssuesApi;
}

function sameJson(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function makeIssue(overrides = {}) {
  return {
    issueKey: 'zai:glm:platform',
    primaryProvider: 'z_ai',
    primaryModel: 'glm-5.2',
    fallbackProvider: 'gemini',
    fallbackModel: 'gemini-3.1-pro',
    credentialScope: 'platform',
    outcome: 'fallback_success',
    errorClass: 'new_provider_failure_class',
    externalCode: null,
    lastSeenAt: '2026-06-24T18:00:00Z',
    occurrencesLast24h: 3,
    actionableByOrgAdmin: false,
    recommendedAction: 'CaptiVet operations has been notified.',
    status: 'active',
    ...overrides,
  };
}

test('provider issues API accepts unknown backend error classes', async () => {
  const calls = [];
  const providerIssuesApi = await loadProviderIssuesApi({
    async get(path, params) {
      calls.push({ method: 'get', path, params });
      return { issues: [makeIssue()] };
    },
  });

  const response = await providerIssuesApi.list({ status: 'active', days: 1 });

  assert.equal(response.issues.length, 1);
  assert.equal(response.issues[0].errorClass, 'new_provider_failure_class');
  assert.equal(response.issues[0].outcome, 'fallback_success');
  sameJson(calls, [
    {
      method: 'get',
      path: '/api/organization/provider-issues',
      params: { status: 'active', days: 1 },
    },
  ]);
});

test('provider issues API acknowledges by issue key', async () => {
  const calls = [];
  const providerIssuesApi = await loadProviderIssuesApi({
    async post(path, body) {
      calls.push({ method: 'post', path, body });
      return { acknowledged: true };
    },
  });

  const response = await providerIssuesApi.acknowledge('issue-1');

  sameJson(response, { acknowledged: true });
  sameJson(calls, [
    {
      method: 'post',
      path: '/api/organization/provider-issues/acknowledge',
      body: { issueKey: 'issue-1' },
    },
  ]);
});
