'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const REQUIRED_REVIEWER = 'philgooddvm-oss';
const MAX_PULL_REQUEST_FILES = 3000;
const ALWAYS_PROTECTED = new Set([
  '.github/r2-protected-paths.txt',
  '.github/workflows/r2-approval-gate.yml',
  '.github/scripts/r2-approval-gate.cjs',
  '.github/scripts/r2-approval-gate.test.cjs',
]);

function readProtectedPaths(root = process.cwd()) {
  return readFileSync(join(root, '.github/r2-protected-paths.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function matchesProtectedPath(path, patterns) {
  if (ALWAYS_PROTECTED.has(path)) return true;
  return patterns.some((pattern) =>
    pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern,
  );
}

function evaluateChangedFiles(files, patterns) {
  const changedPaths = [
    ...new Set(
      files.flatMap((file) =>
        [file.filename, file.previous_filename].filter(
          (path) => typeof path === 'string',
        ),
      ),
    ),
  ];
  const protectedPaths = changedPaths.filter((path) =>
    matchesProtectedPath(path, patterns),
  );
  const mayBeTruncated = files.length >= MAX_PULL_REQUEST_FILES;

  return {
    approvalRequired: mayBeTruncated || protectedPaths.length > 0,
    mayBeTruncated,
    protectedPaths,
  };
}

function hasCurrentApproval(reviews, headSha, reviewer = REQUIRED_REVIEWER) {
  const decisions = reviews.filter(
    (review) =>
      review.user?.login?.toLowerCase() === reviewer.toLowerCase() &&
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state),
  );
  const latest = decisions.at(-1);
  return latest?.state === 'APPROVED' && latest.commit_id === headSha;
}

async function run({ github, context, core, root = process.cwd() }) {
  const pullNumber = context.payload.pull_request?.number;
  if (!pullNumber)
    throw new Error('R2 Approval Gate requires a pull request event');

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const patterns = readProtectedPaths(root);
  const changedFiles = evaluateChangedFiles(files, patterns);

  if (!changedFiles.approvalRequired) {
    core.info('No R2-protected paths changed; approval gate passes.');
    return;
  }
  if (changedFiles.mayBeTruncated) {
    core.warning(
      `Pull request file list reached GitHub's ${MAX_PULL_REQUEST_FILES}-file cap; requiring R2 approval because the list may be truncated.`,
    );
  }

  const [{ data: pull }, reviews] = await Promise.all([
    github.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    github.paginate(github.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    }),
  ]);

  if (!hasCurrentApproval(reviews, pull.head.sha)) {
    core.setFailed(
      `R2-protected paths require @${REQUIRED_REVIEWER} approval on current head ${pull.head.sha}.`,
    );
    return;
  }

  core.info(
    `R2 approval is current for ${changedFiles.protectedPaths.length} returned protected path(s) at ${pull.head.sha}.`,
  );
}

module.exports = {
  ALWAYS_PROTECTED,
  MAX_PULL_REQUEST_FILES,
  REQUIRED_REVIEWER,
  evaluateChangedFiles,
  hasCurrentApproval,
  matchesProtectedPath,
  readProtectedPaths,
  run,
};
