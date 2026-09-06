'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const REQUIRED_REVIEWER = 'philgooddvm-oss';
const MAX_PULL_REQUEST_FILES = 3000;
const APPROVAL_CONTEXT = 'R2 Current-Head Approval';
const ALWAYS_PROTECTED = new Set([
  '.github/r2-protected-paths.txt',
  '.github/workflows/r2-approval-gate.yml',
  '.github/scripts/r2-approval-gate.cjs',
  '.github/scripts/r2-approval-gate.test.cjs',
  '.github/workflows/self-hosted-ci-attest.yml',
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
    pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern
  );
}

function evaluateChangedFiles(files, patterns) {
  const changedPaths = [
    ...new Set(
      files.flatMap((file) =>
        [file.filename, file.previous_filename].filter((path) => typeof path === 'string')
      )
    ),
  ];
  const protectedPaths = changedPaths.filter((path) => matchesProtectedPath(path, patterns));
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
      ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
  );
  decisions.sort(
    (left, right) =>
      (Date.parse(left.submitted_at) || 0) - (Date.parse(right.submitted_at) || 0) ||
      (left.id || 0) - (right.id || 0)
  );
  const latest = decisions.at(-1);
  return latest?.state === 'APPROVED' && latest.commit_id === headSha;
}

async function evaluateApproval({ github, context, pullNumber, root = process.cwd() }) {
  const params = { ...context.repo, pull_number: pullNumber };
  const { data: pull } = await github.rest.pulls.get(params);
  if (
    pull.number !== pullNumber ||
    pull.state !== 'open' ||
    pull.base.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
    pull.base.ref !== 'main' ||
    !Number.isInteger(pull.changed_files) ||
    pull.changed_files < 0 ||
    !pull.head.sha
  ) {
    throw new Error('PR identity or current head could not be verified');
  }
  const [files, reviews] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { ...params, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { ...params, per_page: 100 }),
  ]);
  const changed = evaluateChangedFiles(files, readProtectedPaths(root));
  if (files.length < pull.changed_files && !changed.mayBeTruncated) {
    throw new Error('Incomplete PR file list');
  }
  const { data: current } = await github.rest.pulls.get(params);
  if (
    current.head.sha !== pull.head.sha ||
    current.base.sha !== pull.base.sha ||
    current.state !== 'open' ||
    current.changed_files !== pull.changed_files
  ) {
    throw new Error('PR changed during approval verification');
  }
  const currentReviews = await github.paginate(github.rest.pulls.listReviews, {
    ...params,
    per_page: 100,
  });
  return {
    pull,
    state:
      !changed.approvalRequired ||
      (hasCurrentApproval(reviews, pull.head.sha) &&
        hasCurrentApproval(currentReviews, pull.head.sha))
        ? 'success'
        : 'pending',
    description: changed.approvalRequired
      ? `Requires @${REQUIRED_REVIEWER} approval on current head`
      : 'No R2-protected paths changed',
  };
}

async function run(options) {
  const pullNumber = options.context.payload.pull_request?.number;
  if (!pullNumber) throw new Error('R2 Approval Gate requires a pull request event');
  const result = await evaluateApproval({ ...options, pullNumber });
  if (result.state !== 'success') options.core.setFailed(result.description);
  else options.core.info(`R2 approval verified at ${result.pull.head.sha}`);
}

async function publish({ github, context, core, root = process.cwd() }) {
  let pulls = [];
  try {
    // The event routes us to an API-verified run; its conclusion is not approval evidence.
    const { data: eventRun } = await github.rest.actions.getWorkflowRun({
      ...context.repo,
      run_id: context.payload.workflow_run.id,
    });
    const { data: workflow } = await github.rest.actions.getWorkflow({
      ...context.repo,
      workflow_id: 'r2-approval-gate.yml',
    });
    if (
      eventRun.workflow_id !== workflow.id ||
      eventRun.path !== '.github/workflows/r2-approval-gate.yml' ||
      eventRun.status !== 'completed' ||
      !['pull_request_target', 'pull_request_review'].includes(eventRun.event)
    ) throw new Error('Untrusted R2 workflow event');

    const repository = `${context.repo.owner}/${context.repo.repo}`;
    if (eventRun.pull_requests?.length) {
      // Retain API-verified head hints only for fail-closed error publication if a PR read fails.
      pulls = eventRun.pull_requests.filter((pull) =>
        pull.base?.repo?.url === `${context.apiUrl || 'https://api.github.com'}/repos/${repository}` &&
        /^[a-f0-9]{40}$/.test(pull.head?.sha));
      pulls = await Promise.all(
        [...new Set(eventRun.pull_requests.map((pull) => pull.number))].map(
          async (pull_number) =>
            (await github.rest.pulls.get({ ...context.repo, pull_number })).data
        )
      );
    } else {
      if (!eventRun.head_branch || eventRun.head_repository?.full_name !== repository) {
        throw new Error('Unverifiable PR routing');
      }
      pulls = (await github.paginate(github.rest.pulls.list, {
        ...context.repo,
        state: 'open',
        head: `${context.repo.owner}:${eventRun.head_branch}`,
        per_page: 100,
      })).filter((pull) => pull.head.ref === eventRun.head_branch &&
        pull.head.repo?.full_name === repository);
    }
    pulls = pulls.filter((pull) => pull.state === 'open' &&
      pull.base.repo?.full_name === repository && pull.base.ref === 'main');
    if (pulls.length !== 1) throw new Error('Ambiguous or missing PR identity');

    const approval = await evaluateApproval({ github, context, pullNumber: pulls[0].number, root });
    pulls = [approval.pull];
    await github.rest.repos.createCommitStatus({
      ...context.repo,
      sha: approval.pull.head.sha,
      context: APPROVAL_CONTEXT,
      state: approval.state,
      description: approval.description,
      target_url: approval.pull.html_url,
    });
  } catch (error) {
    // Known candidates must not retain success when verification fails.
    for (const pull of pulls) {
      await github.rest.repos.createCommitStatus({
        ...context.repo,
        sha: pull.head.sha,
        context: APPROVAL_CONTEXT,
        state: 'error',
        description: 'Approval verification failed; inspect trusted publisher logs',
      });
    }
    core.setFailed(error.message);
  }
}

module.exports = {
  APPROVAL_CONTEXT,
  ALWAYS_PROTECTED,
  MAX_PULL_REQUEST_FILES,
  REQUIRED_REVIEWER,
  evaluateApproval,
  evaluateChangedFiles,
  hasCurrentApproval,
  matchesProtectedPath,
  readProtectedPaths,
  publish,
  run,
};
