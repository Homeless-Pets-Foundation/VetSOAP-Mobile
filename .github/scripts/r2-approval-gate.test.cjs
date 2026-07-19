'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hasCurrentApproval,
  matchesProtectedPath,
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
