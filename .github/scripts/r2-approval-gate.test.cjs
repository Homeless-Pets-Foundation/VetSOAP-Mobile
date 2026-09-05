'use strict';

// Rollout probe: this protected-path change must remain pending without owner approval.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_PULL_REQUEST_FILES,
  evaluateChangedFiles,
  hasCurrentApproval,
  matchesProtectedPath,
  publish,
  APPROVAL_CONTEXT,
} = require('./r2-approval-gate.cjs');

const reviewer = { login: 'philgooddvm-oss' };

test('R2 gate protects configured prefixes and its own approval files', () => {
  assert.equal(
    matchesProtectedPath('src/lib/r2UploadUrl.ts', ['src/lib/r2UploadUrl.ts']),
    true,
  );
  assert.equal(
    matchesProtectedPath('.github/workflows/r2-approval-gate.yml', []),
    true,
  );
  assert.equal(
    matchesProtectedPath('.github/r2-protected-paths.txt', []),
    true,
  );
  assert.equal(
    matchesProtectedPath('src/components/Button.tsx', [
      'src/lib/r2UploadUrl.ts',
    ]),
    false,
  );
});

test('R2 gate matches both sides of protected-file renames', () => {
  assert.deepEqual(
    evaluateChangedFiles(
      [
        {
          filename: 'src/lib/renamedSslPinning.ts',
          previous_filename: 'src/lib/sslPinning.ts',
          status: 'renamed',
        },
      ],
      ['src/lib/sslPinning.ts'],
    ),
    {
      approvalRequired: true,
      mayBeTruncated: false,
      protectedPaths: ['src/lib/sslPinning.ts'],
    },
  );
  assert.equal(
    evaluateChangedFiles(
      [
        {
          filename: 'src/lib/sslPinning.ts',
          previous_filename: 'src/lib/unprotected.ts',
          status: 'renamed',
        },
      ],
      ['src/lib/sslPinning.ts'],
    ).approvalRequired,
    true,
  );
});

test('R2 gate fails closed at GitHub file-list truncation boundary', () => {
  const file = (index) => ({ filename: `src/unprotected-${index}.ts` });
  assert.equal(
    evaluateChangedFiles(
      Array.from({ length: MAX_PULL_REQUEST_FILES - 1 }, (_, index) =>
        file(index),
      ),
      [],
    ).approvalRequired,
    false,
  );
  assert.deepEqual(
    evaluateChangedFiles(
      Array.from({ length: MAX_PULL_REQUEST_FILES }, (_, index) => file(index)),
      [],
    ),
    {
      approvalRequired: true,
      mayBeTruncated: true,
      protectedPaths: [],
    },
  );
});

test('R2 gate accepts only required-reviewer approval on current head SHA', () => {
  assert.equal(
    hasCurrentApproval(
      [{ user: reviewer, state: 'APPROVED', commit_id: 'head' }],
      'head',
    ),
    true,
  );
  assert.equal(
    hasCurrentApproval(
      [
        {
          user: { login: 'someone-else' },
          state: 'APPROVED',
          commit_id: 'head',
        },
      ],
      'head',
    ),
    false,
  );
});

test('R2 gate invalidates stale SHA, requested changes, and dismissed approval', () => {
  assert.equal(
    hasCurrentApproval(
      [{ user: reviewer, state: 'APPROVED', commit_id: 'earlier' }],
      'head',
    ),
    false,
  );
  assert.equal(
    hasCurrentApproval(
      [
        { user: reviewer, state: 'APPROVED', commit_id: 'head' },
        { user: reviewer, state: 'CHANGES_REQUESTED', commit_id: 'head' },
      ],
      'head',
    ),
    false,
  );
  assert.equal(
    hasCurrentApproval(
      [{ user: reviewer, state: 'DISMISSED', commit_id: 'head' }],
      'head',
    ),
    false,
  );
});

function publisherFixture() {
  const repository = 'Homeless-Pets-Foundation/VetSOAP-Mobile';
  const pull = {
    number: 206, state: 'open', changed_files: 1,
    html_url: `https://github.com/${repository}/pull/206`,
    head: { sha: 'a'.repeat(40), ref: 'fix/example', repo: { full_name: repository } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: repository } },
  };
  const fixture = {
    pull, files: [{ filename: '.github/workflows/self-hosted-ci-attest.yml' }],
    reviews: [], statuses: [], failures: [], getCount: 0, reviewCount: 0,
    event: {
      id: 9, workflow_id: 10, path: '.github/workflows/r2-approval-gate.yml',
      status: 'completed', event: 'pull_request_review', conclusion: 'success',
      head_sha: 'old-event-sha', head_branch: pull.head.ref,
      head_repository: pull.head.repo, pull_requests: [{ number: pull.number,
        head: pull.head, base: { repo: { url: `https://api.github.com/repos/${repository}` } } }],
    },
  };
  fixture.github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: fixture.event }),
        getWorkflow: async () => ({ data: { id: 10 } }),
      },
      pulls: {
        get: async () => {
          fixture.onGet?.(++fixture.getCount);
          return { data: structuredClone(fixture.pull) };
        },
        listFiles: 'files', listReviews: 'reviews', list: 'pulls',
      },
      repos: { createCommitStatus: async (status) => fixture.statuses.push(status) },
    },
    paginate: async (method) => {
      if (method === 'reviews') fixture.onReviews?.(++fixture.reviewCount);
      if (fixture.failMethod === method) throw new Error('API unavailable');
      return structuredClone(method === 'pulls' ? (fixture.candidates || [fixture.pull]) : fixture[method]);
    },
  };
  fixture.approve = () => { fixture.reviews = [{ user: reviewer, state: 'APPROVED',
    commit_id: fixture.pull.head.sha, id: 1, submitted_at: '2026-09-05T12:00:00Z' }]; };
  fixture.run = () => publish({ github: fixture.github,
    context: { repo: { owner: 'Homeless-Pets-Foundation', repo: 'VetSOAP-Mobile' },
      payload: { workflow_run: { id: 9, pull_requests: [{ number: 999 }] } } },
    core: { setFailed: (message) => fixture.failures.push(message) },
  });
  return fixture;
}

test('publisher grants approval only from API reviews and never reruns CI or old R2 checks', async () => {
  const f = publisherFixture();
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'pending');
  f.approve();
  f.event.conclusion = 'failure';
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'success');
  assert.equal(f.statuses.at(-1).sha, f.pull.head.sha);
  assert.equal(f.statuses.at(-1).context, APPROVAL_CONTEXT);
  assert.deepEqual(f.failures, []);
  // The mock exposes no rerun/job-result APIs: only the approval context can change.
  assert.ok(f.statuses.every((status) => status.context === APPROVAL_CONTEXT));
});

test('unprotected changes pass without approval; incomplete file lists fail closed', async () => {
  const f = publisherFixture();
  f.files = [{ filename: 'README.md' }];
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'success');
  f.pull.changed_files = 2;
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'error');
});

for (const state of ['DISMISSED', 'CHANGES_REQUESTED']) {
  test(`delayed approval events cannot undo ${state}`, async () => {
    const f = publisherFixture(); f.approve(); await f.run();
    f.reviews.push({ user: reviewer, state, commit_id: f.pull.head.sha,
      id: 2, submitted_at: '2026-09-05T13:00:00Z' });
    f.reviews.reverse(); // Do not rely on API response order.
    await f.run();
    assert.deepEqual(f.statuses.map((status) => status.state), ['success', 'pending']);
  });
}

test('a new commit cannot reuse an old approval', async () => {
  const f = publisherFixture(); f.approve();
  f.pull.head.sha = 'c'.repeat(40);
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'pending');
  assert.equal(f.statuses.at(-1).sha, f.pull.head.sha);
});

test('review dismissal during verification cannot grant approval', async () => {
  const f = publisherFixture(); f.approve();
  f.onReviews = (count) => { if (count === 2) f.reviews[0].state = 'DISMISSED'; };
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'pending');
});

for (const change of ['head', 'base', 'files', 'closed']) {
  test(`PR ${change} mutation during verification fails closed`, async () => {
    const f = publisherFixture(); f.approve();
    f.onGet = (count) => {
      if (count !== 3) return;
      if (change === 'head') f.pull.head.sha = 'c'.repeat(40);
      if (change === 'base') f.pull.base.sha = 'd'.repeat(40);
      if (change === 'files') f.pull.changed_files++;
      if (change === 'closed') f.pull.state = 'closed';
    };
    await f.run();
    assert.equal(f.statuses.at(-1).state, 'error');
  });
}

for (const method of ['files', 'reviews']) {
  test(`${method} API failures cannot retain success`, async () => {
    const f = publisherFixture(); f.approve(); await f.run();
    f.failMethod = method;
    await f.run();
    assert.deepEqual(f.statuses.map((status) => status.state), ['success', 'error']);
  });
}

test('branch fallback rejects ambiguous PRs and fork routing', async () => {
  const f = publisherFixture(); f.approve(); f.event.pull_requests = [];
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'success');
  f.candidates = [f.pull, { ...f.pull, number: 207 }];
  await f.run();
  assert.ok(f.statuses.slice(1).every((status) => status.state === 'error'));
  f.statuses = [];
  f.event.head_repository = { full_name: 'someone/fork' };
  await f.run();
  assert.deepEqual(f.statuses, []);
  assert.match(f.failures.at(-1), /routing/);
});

test('unrelated workflow events cannot publish approval', async () => {
  const f = publisherFixture(); f.approve(); f.event.workflow_id = 99;
  await f.run();
  assert.deepEqual(f.statuses, []);
  assert.match(f.failures.at(-1), /Untrusted/);
});

test('PR API failure invalidates a known event head without granting approval from metadata', async () => {
  const f = publisherFixture();
  f.github.rest.pulls.get = async () => { throw new Error('PR API unavailable'); };
  await f.run();
  assert.equal(f.statuses.at(-1).state, 'error');
  assert.equal(f.statuses.at(-1).sha, f.event.pull_requests[0].head.sha);
});

test('publisher runs only trusted default-branch code in a separate serialized permission scope', () => {
  const { readFileSync } = require('node:fs');
  const workflow = readFileSync('.github/workflows/self-hosted-ci-attest.yml', 'utf8');
  const publisher = workflow.split('  publish-r2-approval:')[1];
  assert.match(workflow, /workflows: \[Self-hosted CI, R2 Approval Gate\]/);
  assert.match(publisher, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(publisher, /statuses: write/);
  assert.doesNotMatch(publisher, /actions: write|pull_request.head|download-artifact/);
  assert.match(publisher, /group: r2-current-head-approval\s+cancel-in-progress: false/);
  assert.equal(matchesProtectedPath('.github/workflows/self-hosted-ci-attest.yml', []), true);
  assert.match(readFileSync('.github/CODEOWNERS', 'utf8'), /self-hosted-ci-attest.yml @philgooddvm-oss/);
});
