import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assembleGithubAttention,
  classifyAttentionItem,
  parseGithubRepoFromRemote,
  summarizeCiStatus,
  summarizeMergeable,
  summarizeReviewState,
} from '../src/github-attention.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('remote URL parsing accepts common GitHub remotes', () => {
  assert.equal(parseGithubRepoFromRemote('https://github.com/thatdudealso/crewboard.git'), 'thatdudealso/crewboard');
  assert.equal(parseGithubRepoFromRemote('git@github.com:thatdudealso/Pet_Diary_APP.git'), 'thatdudealso/Pet_Diary_APP');
  assert.equal(parseGithubRepoFromRemote('ssh://git@github.com/acme/api'), 'acme/api');
  assert.equal(parseGithubRepoFromRemote('https://gitlab.com/acme/api.git'), null);
});

test('CI and mergeable summarizers classify rollup states', () => {
  assert.equal(summarizeCiStatus([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'success');
  assert.equal(summarizeCiStatus([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ]), 'failure');
  assert.equal(summarizeCiStatus([{ status: 'IN_PROGRESS', conclusion: null }]), 'pending');
  assert.equal(summarizeMergeable('MERGEABLE'), 'mergeable');
  assert.equal(summarizeMergeable('CONFLICTING'), 'conflicting');
  assert.equal(summarizeMergeable('UNKNOWN'), 'unknown');
});

test('review state distinguishes captain review requests from approvals', () => {
  assert.equal(summarizeReviewState({
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: [{ login: 'thatdudealso' }],
  }, 'thatdudealso'), 'awaiting_captain');
  assert.equal(summarizeReviewState({
    reviewDecision: 'APPROVED',
    reviewRequests: [],
  }, 'thatdudealso'), 'approved');
  assert.equal(summarizeReviewState({
    reviewDecision: '',
    reviewRequests: [],
  }, 'thatdudealso'), 'none');
});

test('classification marks review requests, conflicts, failing CI, and merge-ready PRs', () => {
  const login = 'thatdudealso';
  const review = classifyAttentionItem({
    repo: 'acme/app',
    number: 1,
    title: 'Needs review',
    url: 'https://github.com/acme/app/pull/1',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: [{ login }],
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    author: { login: 'teammate' },
    assignees: [],
    body: '',
  }, { login, kind: 'pr' });
  assert.equal(review.needsAttention, true);
  assert.deepEqual(review.reasons, ['review_requested']);
  assert.equal(review.reviewState, 'awaiting_captain');

  const conflicts = classifyAttentionItem({
    repo: 'acme/app',
    number: 2,
    title: 'Conflicts',
    url: 'https://github.com/acme/app/pull/2',
    isDraft: false,
    reviewDecision: '',
    reviewRequests: [],
    mergeable: 'CONFLICTING',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    author: { login },
    assignees: [],
    body: '',
  }, { login, kind: 'pr' });
  assert.ok(conflicts.reasons.includes('conflicts'));

  const failing = classifyAttentionItem({
    repo: 'acme/app',
    number: 3,
    title: 'Red CI',
    url: 'https://github.com/acme/app/pull/3',
    isDraft: false,
    reviewDecision: 'APPROVED',
    reviewRequests: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    author: { login },
    assignees: [],
    body: '',
  }, { login, kind: 'pr' });
  assert.ok(failing.reasons.includes('ci_failing'));

  const mergeReady = classifyAttentionItem({
    repo: 'acme/app',
    number: 4,
    title: 'Ready',
    url: 'https://github.com/acme/app/pull/4',
    isDraft: false,
    reviewDecision: 'APPROVED',
    reviewRequests: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    author: { login },
    assignees: [],
    body: '',
  }, { login, kind: 'pr' });
  assert.ok(mergeReady.reasons.includes('merge_ready'));
  assert.equal(mergeReady.needsAttention, true);

  const quiet = classifyAttentionItem({
    repo: 'acme/app',
    number: 5,
    title: 'Someone else drafting',
    url: 'https://github.com/acme/app/pull/5',
    isDraft: true,
    reviewDecision: '',
    reviewRequests: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    author: { login: 'teammate' },
    assignees: [],
    body: '',
  }, { login, kind: 'pr' });
  assert.equal(quiet.needsAttention, false);

  const assignedIssue = classifyAttentionItem({
    repo: 'acme/app',
    number: 9,
    title: 'Assigned to captain',
    url: 'https://github.com/acme/app/issues/9',
    assignees: [{ login }],
    author: { login: 'teammate' },
    body: 'Please take a look',
  }, { login, kind: 'issue' });
  assert.ok(assignedIssue.reasons.includes('assigned'));
  assert.equal(assignedIssue.needsAttention, true);

  const mentioned = classifyAttentionItem({
    repo: 'acme/app',
    number: 10,
    title: 'Mention',
    url: 'https://github.com/acme/app/issues/10',
    assignees: [],
    author: { login: 'teammate' },
    body: 'cc @thatdudealso for product call',
  }, { login, kind: 'issue' });
  assert.ok(mentioned.reasons.includes('mentioned'));
});

test('feed assembly filters to attention by default and reports honest unavailable state', async () => {
  const root = await temporaryDirectory();
  const workspaceFile = path.join(root, 'fleet-workspace.json');
  await fs.writeFile(workspaceFile, `${JSON.stringify({
    schemaVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projects: [],
    githubAttention: {
      repos: ['thatdudealso/crewboard', 'thatdudealso/Pet_Diary_APP'],
      login: 'thatdudealso',
    },
  }, null, 2)}\n`);

  const fixtures = {
    'pr list thatdudealso/crewboard': [
      {
        number: 1,
        title: 'Needs captain review',
        url: 'https://github.com/thatdudealso/crewboard/pull/1',
        isDraft: false,
        reviewDecision: 'REVIEW_REQUIRED',
        reviewRequests: [{ login: 'thatdudealso' }],
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        author: { login: 'teammate' },
        assignees: [],
        body: '',
      },
      {
        number: 2,
        title: 'Quiet teammate draft',
        url: 'https://github.com/thatdudealso/crewboard/pull/2',
        isDraft: true,
        reviewDecision: '',
        reviewRequests: [],
        mergeable: 'MERGEABLE',
        statusCheckRollup: [],
        author: { login: 'teammate' },
        assignees: [],
        body: '',
      },
    ],
    'pr list thatdudealso/Pet_Diary_APP': [
      {
        number: 8,
        title: 'Captain conflict',
        url: 'https://github.com/thatdudealso/Pet_Diary_APP/pull/8',
        isDraft: false,
        reviewDecision: '',
        reviewRequests: [],
        mergeable: 'CONFLICTING',
        statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
        author: { login: 'thatdudealso' },
        assignees: [],
        body: '',
      },
    ],
    'issue list thatdudealso/crewboard': [],
    'issue list thatdudealso/Pet_Diary_APP': [],
    'mentions thatdudealso/crewboard': [],
    'mentions thatdudealso/Pet_Diary_APP': [],
  };

  function runGh(args) {
    if (args[0] === 'api' && args[1] === 'user') return 'thatdudealso\n';
    if (args[0] === 'pr' && args[1] === 'list') {
      const repo = args[args.indexOf('-R') + 1];
      return JSON.stringify(fixtures[`pr list ${repo}`] || []);
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      const repo = args[args.indexOf('-R') + 1];
      return JSON.stringify(fixtures[`issue list ${repo}`] || []);
    }
    if (args[0] === 'search' && args[1] === 'issues') {
      const repo = args[args.indexOf('--repo') + 1];
      return JSON.stringify(fixtures[`mentions ${repo}`] || []);
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  }

  const attention = await assembleGithubAttention({
    workspaceFile,
    all: false,
    runGh,
    clock: () => '2026-08-10T12:00:00.000Z',
  });
  assert.equal(attention.available, true);
  assert.equal(attention.sourceFound, true);
  assert.equal(attention.items.length, 2);
  assert.deepEqual(attention.items.map((item) => item.number).sort(), [1, 8]);
  assert.equal(attention.refreshedAt, '2026-08-10T12:00:00.000Z');

  const all = await assembleGithubAttention({
    workspaceFile,
    all: true,
    runGh,
    clock: () => '2026-08-10T12:00:00.000Z',
  });
  assert.equal(all.items.length, 3);

  const unavailable = await assembleGithubAttention({
    workspaceFile,
    runGh() {
      const error = new Error('gh auth: not logged in');
      error.code = 'github_unauthenticated';
      throw error;
    },
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.sourceFound, false);
  assert.equal(unavailable.items.length, 0);
  assert.match(unavailable.error, /not logged in/);
});

test('feed auto-suggests GitHub remotes from approved workspace projects', async () => {
  const root = await temporaryDirectory();
  const boardPath = path.join(root, 'pet');
  await fs.mkdir(boardPath, { recursive: true });
  const workspaceFile = path.join(root, 'fleet-workspace.json');
  await fs.writeFile(workspaceFile, `${JSON.stringify({
    schemaVersion: 2,
    projects: [{
      id: 'project-pet',
      name: 'Pet Diary',
      path: boardPath,
      boardPath,
      origin: 'manual',
      state: 'active',
      organization: 'Unsorted',
      position: 1,
    }],
    githubAttention: { repos: [] },
  }, null, 2)}\n`);

  const feed = await assembleGithubAttention({
    workspaceFile,
    runGh(args) {
      if (args[0] === 'api') return 'thatdudealso\n';
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'search') return '[]';
      throw new Error(args.join(' '));
    },
    readRemote: () => 'https://github.com/thatdudealso/Pet_Diary_APP.git',
    clock: () => '2026-08-10T12:00:00.000Z',
  });
  assert.deepEqual(feed.repos, ['thatdudealso/Pet_Diary_APP']);
  assert.deepEqual(feed.suggestedRepos, ['thatdudealso/Pet_Diary_APP']);
});
