import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the workflow's actual attestation loop against assigned-runner evidence.
const workflow = readFileSync('.github/workflows/self-hosted-ci-gate.yml', 'utf8');
const start = workflow.indexOf('            const hostedLinux');
const end = workflow.indexOf('            if (failures.length > 0)', start);
const check = new Function('jobs', `${workflow.slice(start, end)}\nreturn failures;`);
const names = ['Confirm PR head', 'R2 Destination Contract', 'Typecheck', 'Lint', 'Test',
  'Expo SDK deps', 'Analyze (javascript-typescript)', 'Review', 'Swift typecheck (durable recorder)'];
const jobs = names.map((name, i) => ({ name, status: 'completed', conclusion: 'success',
  labels: i === 8 ? ['self-hosted', 'local-ci', 'macOS', 'ARM64'] : ['ubuntu-24.04'],
  runner_name: i === 8 ? 'vetsoap-local-ci-macos' : 'GitHub Actions 123', runner_group_name: 'GitHub Actions' }));
assert.deepEqual(check(jobs), []);
for (const change of [{ runner_name: '' }, { runner_group_name: 'Default' },
  { labels: ['runs-on=123/runner=linux-ci'] }, { conclusion: 'failure' }]) {
  assert.equal(check([{ ...jobs[0], ...change }, ...jobs.slice(1)]).length, 1);
}
assert.equal(check(jobs.slice(1)).length, 1);
assert.equal(check([...jobs, jobs[0]]).length, 1);
console.log('Runner attestation checks passed');
