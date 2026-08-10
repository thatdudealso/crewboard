import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { openWorkspace } from './workspace.js';
import { now, pathExists } from './utils.js';

const PR_LIST_FIELDS = [
  'number',
  'title',
  'url',
  'isDraft',
  'reviewDecision',
  'mergeable',
  'statusCheckRollup',
  'author',
  'assignees',
  'reviewRequests',
  'body',
].join(',');

const ISSUE_LIST_FIELDS = ['number', 'title', 'url', 'assignees', 'author', 'body'].join(',');

function defaultRunGh(args, { timeout = 60_000 } = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    timeout,
    env: process.env,
  });
  if (result.error) {
    const error = new Error(result.error.code === 'ENOENT'
      ? 'GitHub CLI (gh) is not installed or not on PATH.'
      : result.error.message);
    error.code = 'github_unavailable';
    throw error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'gh command failed').trim();
    const error = new Error(detail || 'gh command failed');
    error.code = /not logged|auth|HTTP 401|HTTP 403/i.test(detail) ? 'github_unauthenticated' : 'github_unavailable';
    throw error;
  }
  return result.stdout;
}

function defaultReadRemote(boardPath) {
  const result = spawnSync('git', ['-C', boardPath, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim() || null;
}

export function parseGithubRepoFromRemote(remoteUrl) {
  if (!remoteUrl) return null;
  const cleaned = remoteUrl.trim().replace(/\.git$/i, '');
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/?$/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\/.*)?$/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

export function normalizeRepoSlug(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\.git$/i, '');
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function uniqueRepos(values) {
  const seen = new Set();
  const repos = [];
  for (const value of values) {
    const slug = normalizeRepoSlug(value);
    if (!slug) continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(slug);
  }
  return repos;
}

export function summarizeCiStatus(statusCheckRollup) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (!checks.length) return 'unknown';
  const states = checks.map((check) => {
    if (check.status && check.status !== 'COMPLETED') return 'pending';
    const conclusion = String(check.conclusion || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) return conclusion === 'SUCCESS' ? 'success' : 'neutral';
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion)) return 'failure';
    if (check.state) {
      const state = String(check.state).toUpperCase();
      if (state === 'SUCCESS') return 'success';
      if (state === 'FAILURE' || state === 'ERROR') return 'failure';
      if (state === 'PENDING') return 'pending';
    }
    return 'unknown';
  });
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.every((state) => state === 'success' || state === 'neutral')) {
    return states.some((state) => state === 'success') ? 'success' : 'neutral';
  }
  return 'unknown';
}

export function summarizeReviewState(pr, login) {
  const requests = (pr.reviewRequests || []).map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry?.login || entry?.name || entry?.slug || null;
  }).filter(Boolean);
  const decision = String(pr.reviewDecision || '').toUpperCase();
  if (login && requests.some((name) => name.toLowerCase() === login.toLowerCase())) return 'awaiting_captain';
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (decision === 'REVIEW_REQUIRED') return 'pending';
  if (requests.length) return 'pending';
  return 'none';
}

export function summarizeMergeable(mergeable) {
  const value = String(mergeable || '').toUpperCase();
  if (value === 'MERGEABLE') return 'mergeable';
  if (value === 'CONFLICTING') return 'conflicting';
  return 'unknown';
}

function mentionsLogin(text, login) {
  if (!text || !login) return false;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return pattern.test(text);
}

function isCaptain(login, candidate) {
  if (!login || !candidate) return false;
  return String(candidate).toLowerCase() === login.toLowerCase();
}

/**
 * Classify a PR or issue into attention reasons and whether it needs the captain.
 * Pure function — unit-tested with fixtures; no network.
 */
export function classifyAttentionItem(raw, { login, kind = 'pr' } = {}) {
  const assignees = (raw.assignees || []).map((entry) => entry?.login || entry).filter(Boolean);
  const author = raw.author?.login || raw.author || null;
  const assignedToCaptain = assignees.some((name) => isCaptain(login, name));
  const authoredByCaptain = isCaptain(login, author);
  const bodyOrTitle = `${raw.title || ''}\n${raw.body || ''}`;
  const mentioned = mentionsLogin(bodyOrTitle, login) || Boolean(raw.mentioned);
  const reasons = [];

  if (kind === 'pr') {
    const reviewState = summarizeReviewState(raw, login);
    const mergeableState = summarizeMergeable(raw.mergeable);
    const ciStatus = summarizeCiStatus(raw.statusCheckRollup);
    const draft = Boolean(raw.isDraft);

    if (reviewState === 'awaiting_captain') reasons.push('review_requested');
    if (authoredByCaptain && mergeableState === 'conflicting') reasons.push('conflicts');
    if (authoredByCaptain && ciStatus === 'failure') reasons.push('ci_failing');
    if (
      authoredByCaptain
      && !draft
      && mergeableState === 'mergeable'
      && (ciStatus === 'success' || ciStatus === 'neutral' || ciStatus === 'unknown')
      && (reviewState === 'approved' || reviewState === 'none')
    ) {
      reasons.push('merge_ready');
    }
    if (assignedToCaptain) reasons.push('assigned');
    if (mentioned) reasons.push('mentioned');

    return {
      kind: 'pr',
      repo: raw.repo,
      number: raw.number,
      title: raw.title,
      url: raw.url,
      draft,
      author,
      assignees,
      reviewState,
      mergeableState,
      ciStatus,
      reasons,
      needsAttention: reasons.length > 0,
    };
  }

  if (assignedToCaptain) reasons.push('assigned');
  if (mentioned) reasons.push('mentioned');
  return {
    kind: 'issue',
    repo: raw.repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    draft: false,
    author,
    assignees,
    reviewState: 'none',
    mergeableState: 'unknown',
    ciStatus: 'unknown',
    reasons,
    needsAttention: reasons.length > 0,
  };
}

export async function suggestReposFromProjects(projects, { readRemote = defaultReadRemote } = {}) {
  const suggestions = [];
  for (const project of projects || []) {
    if (project.state && project.state !== 'active') continue;
    const boardPath = project.boardPath || project.path;
    if (!boardPath || !(await pathExists(boardPath))) continue;
    const remote = readRemote(boardPath);
    const slug = parseGithubRepoFromRemote(remote);
    if (slug) suggestions.push({ repo: slug, fromProjectId: project.id, fromProjectName: project.name });
  }
  const repos = uniqueRepos(suggestions.map((entry) => entry.repo));
  return {
    repos,
    suggestions: suggestions.filter((entry, index, list) => list.findIndex((candidate) => candidate.repo.toLowerCase() === entry.repo.toLowerCase()) === index),
  };
}

export function readGithubAttentionConfig(workspace) {
  const section = workspace?.githubAttention || {};
  return {
    repos: uniqueRepos(section.repos || []),
    login: section.login || null,
  };
}

function unavailableResult({ error, repos = [], suggestedRepos = [], mode = 'attention' }) {
  return {
    available: false,
    sourceFound: false,
    source: 'github',
    error: error.message || String(error),
    code: error.code || 'github_unavailable',
    login: null,
    repos,
    suggestedRepos,
    items: [],
    mode,
    refreshedAt: null,
  };
}

function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(stdout || 'null');
  } catch {
    const error = new Error(`Could not parse GitHub ${label} response as JSON.`);
    error.code = 'github_unavailable';
    throw error;
  }
}

async function resolveCaptainLogin(configLogin, runGh) {
  if (configLogin) return configLogin;
  const stdout = runGh(['api', 'user', '--jq', '.login']);
  return String(stdout || '').trim() || null;
}

function enrichPrMergeable(pr, repo, runGh) {
  if (summarizeMergeable(pr.mergeable) !== 'unknown') return pr;
  try {
    const detail = parseJsonOutput(
      runGh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'mergeable,mergeStateStatus']),
      `pr ${repo}#${pr.number}`,
    );
    return { ...pr, mergeable: detail.mergeable || pr.mergeable };
  } catch {
    return pr;
  }
}

function fetchRepoPullRequests(repo, runGh) {
  const listed = parseJsonOutput(
    runGh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '50', '--json', PR_LIST_FIELDS]),
    `pr list ${repo}`,
  ) || [];
  return listed.map((pr) => enrichPrMergeable({ ...pr, repo }, repo, runGh));
}

function fetchRepoIssues(repo, login, runGh) {
  if (!login) return [];
  const listed = parseJsonOutput(
    runGh(['issue', 'list', '-R', repo, '--state', 'open', '--assignee', login, '--limit', '50', '--json', ISSUE_LIST_FIELDS]),
    `issue list ${repo}`,
  ) || [];
  return listed.map((issue) => ({ ...issue, repo }));
}

function fetchMentions(repo, login, runGh) {
  if (!login) return [];
  try {
    const stdout = runGh([
      'search',
      'issues',
      '--mentions',
      login,
      '--repo',
      repo,
      '--state',
      'open',
      '--include-prs',
      '--limit',
      '50',
      '--json',
      'kind,number,title,url,repository',
    ]);
    return parseJsonOutput(stdout, `mentions ${repo}`) || [];
  } catch {
    return [];
  }
}

function itemKey(item) {
  return `${item.kind}:${item.repo}:${item.number}`.toLowerCase();
}

/**
 * Assemble the captain GitHub attention feed for configured + suggested repos.
 * Inject runGh / readRemote for tests.
 */
export async function assembleGithubAttention({
  workspaceFile,
  cwd = process.cwd(),
  all = false,
  runGh = defaultRunGh,
  readRemote = defaultReadRemote,
  clock = now,
} = {}) {
  const resolvedWorkspace = path.resolve(cwd, workspaceFile || 'crewboard-workspace.json');
  let workspace = { projects: [] };
  let config = { repos: [], login: null };
  if (await pathExists(resolvedWorkspace)) {
    ({ workspace } = await openWorkspace(resolvedWorkspace));
    config = readGithubAttentionConfig(workspace);
  }

  const suggested = await suggestReposFromProjects(workspace.projects || [], { readRemote });
  const repos = uniqueRepos([...config.repos, ...suggested.repos]);
  const mode = all ? 'all' : 'attention';

  let login;
  try {
    login = await resolveCaptainLogin(config.login, runGh);
  } catch (error) {
    return unavailableResult({ error, repos, suggestedRepos: suggested.repos, mode });
  }

  if (!repos.length) {
    return {
      available: true,
      sourceFound: true,
      source: 'github',
      login,
      repos: [],
      suggestedRepos: suggested.repos,
      configuredRepos: config.repos,
      items: [],
      mode,
      notice: 'No GitHub repositories configured or suggested from approved project remotes.',
      refreshedAt: clock(),
    };
  }

  const byKey = new Map();
  try {
    for (const repo of repos) {
      const pullRequests = fetchRepoPullRequests(repo, runGh);
      for (const pr of pullRequests) {
        const item = classifyAttentionItem(pr, { login, kind: 'pr' });
        byKey.set(itemKey(item), item);
      }

      const issues = fetchRepoIssues(repo, login, runGh);
      for (const issue of issues) {
        const item = classifyAttentionItem(issue, { login, kind: 'issue' });
        byKey.set(itemKey(item), item);
      }

      const mentions = fetchMentions(repo, login, runGh);
      for (const mention of mentions) {
        const kind = String(mention.kind || '').toLowerCase() === 'pullrequest' ? 'pr' : 'issue';
        const key = `${kind}:${repo}:${mention.number}`.toLowerCase();
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.reasons.includes('mentioned')) existing.reasons.push('mentioned');
          existing.needsAttention = true;
          continue;
        }
        if (kind === 'pr') continue;
        const item = classifyAttentionItem({
          ...mention,
          repo,
          mentioned: true,
          assignees: mention.assignees || [],
          author: mention.author || null,
          body: mention.body || '',
        }, { login, kind: 'issue' });
        byKey.set(itemKey(item), item);
      }
    }
  } catch (error) {
    return unavailableResult({ error, repos, suggestedRepos: suggested.repos, mode });
  }

  let items = [...byKey.values()];
  if (!all) items = items.filter((item) => item.needsAttention);
  items.sort((left, right) => left.repo.localeCompare(right.repo) || left.kind.localeCompare(right.kind) || right.number - left.number);

  return {
    available: true,
    sourceFound: true,
    source: 'github',
    login,
    repos,
    suggestedRepos: suggested.repos,
    configuredRepos: config.repos,
    items,
    mode,
    refreshedAt: clock(),
  };
}

