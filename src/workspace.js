import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { withFileLock } from './lock.js';
import { BoardStore } from './store.js';
import { now, pathExists } from './utils.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'coverage', 'dist', 'node_modules', 'vendor']);

function expandHome(value) {
  if (!value) return value;
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function absolutePath(value) {
  return value ? path.resolve(expandHome(value)) : null;
}

function generatedProjectId(value) {
  return `project-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeProject(project, index) {
  const timestamp = project.createdAt || now();
  const boardPath = absolutePath(project.boardPath || project.path);
  return {
    id: project.id || generatedProjectId(project.path || project.name || String(index)),
    name: project.name || path.basename(boardPath || 'untitled-project'),
    path: absolutePath(project.path),
    boardPath,
    origin: project.origin || 'manual',
    sourceLocation: project.sourceLocation || null,
    sourceId: project.sourceId || null,
    state: project.state || 'active',
    organization: project.organization || 'Unsorted',
    position: Number.isFinite(project.position) ? project.position : index + 1,
    createdAt: timestamp,
    updatedAt: project.updatedAt || timestamp,
    archivedAt: project.archivedAt || null,
  };
}

function normalizeWorkspace(workspace) {
  const projects = (workspace.projects || []).map(normalizeProject);
  return {
    schemaVersion: 2,
    createdAt: workspace.createdAt || now(),
    updatedAt: workspace.updatedAt || workspace.createdAt || now(),
    projects,
  };
}

async function writeWorkspace(filePath, workspace) {
  workspace.updatedAt = now();
  await atomicWriteFile(filePath, `${JSON.stringify(workspace, null, 2)}\n`);
}

async function withWorkspaceLock(filePath, operation) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return withFileLock(`${filePath}.lock`, 'Workspace is busy with another mutation. Retry the command.', operation);
}

async function openWorkspaceUnlocked(filePath) {
  try {
    return { filePath, workspace: normalizeWorkspace(JSON.parse(await fs.readFile(filePath, 'utf8'))) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Workspace not found at ${filePath}. Run \`crewboard workspace init\`.`);
    throw error;
  }
}

function projectKey(project) {
  return `${project.origin}:${project.path || project.sourceLocation || ''}:${project.sourceId || project.name}`;
}

function sortProjects(projects) {
  return [...projects].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
}

function candidateFromPath(candidatePath, origin, sourceLocation) {
  return {
    name: path.basename(candidatePath),
    path: candidatePath,
    boardPath: candidatePath,
    origin,
    sourceLocation,
  };
}

async function scanGitRepositories(root) {
  const candidates = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '.git')) {
      candidates.push(directory);
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => visit(path.join(directory, entry.name))));
  }
  if (await pathExists(root)) await visit(root);
  return candidates.sort((left, right) => left.localeCompare(right));
}

async function discoverLocalProjects(root) {
  const scanRoot = absolutePath(root || path.join(os.homedir(), 'src'));
  if (!(await pathExists(scanRoot))) return { sourceFound: false, sourceLocation: scanRoot, candidates: [] };
  const repositories = await scanGitRepositories(scanRoot);
  return {
    sourceFound: true,
    sourceLocation: scanRoot,
    candidates: repositories.map((repository) => candidateFromPath(repository, 'local', scanRoot)),
  };
}

async function discoverClaudeProjects(root) {
  const configuredRoot = root ? [absolutePath(root)] : [
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude'),
  ];
  const roots = [];
  for (const candidateRoot of configuredRoot) if (await pathExists(candidateRoot)) roots.push(candidateRoot);
  if (!roots.length) return { sourceFound: false, sourceLocation: configuredRoot[0], candidates: [] };
  const projects = [];
  for (const claudeRoot of roots) {
    const repositories = await scanGitRepositories(claudeRoot);
    if (repositories.length) projects.push(...repositories.map((repository) => candidateFromPath(repository, 'claude', claudeRoot)));
    else {
      const entries = await fs.readdir(claudeRoot, { withFileTypes: true }).catch(() => []);
      projects.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => ({
        name: entry.name,
        path: path.join(claudeRoot, entry.name),
        boardPath: null,
        origin: 'claude',
        sourceLocation: claudeRoot,
      })));
    }
  }
  const seen = new Set();
  return {
    sourceFound: true,
    sourceLocation: roots.join(', '),
    candidates: projects.filter((project) => {
      const key = `${project.sourceLocation}:${project.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

function extractChatGptProjects(exported) {
  const candidates = Array.isArray(exported) ? exported : exported.projects || exported.data?.projects || exported.items || [];
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((candidate) => candidate && typeof candidate === 'object').map((candidate, index) => ({
    name: String(candidate.name || candidate.title || candidate.project_name || candidate.id || `ChatGPT project ${index + 1}`),
    path: candidate.path || candidate.localPath || candidate.directory || null,
    boardPath: candidate.path || candidate.localPath || candidate.directory || null,
    origin: 'chatgpt',
    sourceLocation: null,
    sourceId: String(candidate.id ?? candidate.uuid ?? candidate.project_id ?? crypto.createHash('sha256').update(canonicalJson(candidate)).digest('hex').slice(0, 24)),
  }));
}

async function discoverChatGptProjects(sourcePath) {
  const configuredPaths = sourcePath ? [absolutePath(sourcePath)] : [
    process.env.CHATGPT_PROJECTS_EXPORT,
    path.join(os.homedir(), '.config', 'chatgpt', 'projects.json'),
    path.join(os.homedir(), 'Downloads', 'chatgpt-projects.json'),
  ].filter(Boolean).map(absolutePath);
  let foundPath = null;
  for (const candidate of configuredPaths) {
    if (await pathExists(candidate)) {
      foundPath = candidate;
      break;
    }
  }
  if (!foundPath) return { sourceFound: false, sourceLocation: configuredPaths[0] || null, candidates: [] };
  const exported = JSON.parse(await fs.readFile(foundPath, 'utf8'));
  return {
    sourceFound: true,
    sourceLocation: foundPath,
    candidates: extractChatGptProjects(exported).map((candidate) => ({ ...candidate, sourceLocation: foundPath })),
  };
}

export async function discoverProjectCandidates({ source, root } = {}) {
  if (!['local', 'claude', 'chatgpt'].includes(source)) throw new Error('Project source must be local, claude, or chatgpt.');
  if (source === 'local') return discoverLocalProjects(root);
  if (source === 'claude') return discoverClaudeProjects(root);
  return discoverChatGptProjects(root);
}

export async function initializeWorkspace(filePath) {
  return withWorkspaceLock(filePath, async () => {
    if (await pathExists(filePath)) throw new Error(`Workspace already exists at ${filePath}`);
    const workspace = normalizeWorkspace({ projects: [] });
    await writeWorkspace(filePath, workspace);
    return { filePath, workspace };
  });
}

export async function ensureWorkspace(filePath) {
  if (await pathExists(filePath)) return openWorkspace(filePath);
  return initializeWorkspace(filePath);
}

export async function openWorkspace(filePath) {
  return openWorkspaceUnlocked(filePath);
}

export async function getProjectRecord(filePath, projectId) {
  const { workspace } = await openWorkspace(filePath);
  const project = workspace.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

export async function addBoardToWorkspace(filePath, boardPath, { origin = 'manual', organization = 'Unsorted' } = {}) {
  const absoluteBoardPath = absolutePath(boardPath);
  const board = await BoardStore.open(absoluteBoardPath);
  return withWorkspaceLock(filePath, async () => {
    const { workspace } = await openWorkspaceUnlocked(filePath);
    const existing = workspace.projects.find((project) => project.boardPath === absoluteBoardPath);
    if (existing) return { filePath, workspace, project: existing, unchanged: true };
    const timestamp = now();
    const project = {
      id: generatedProjectId(absoluteBoardPath),
      name: board.config.name,
      path: absoluteBoardPath,
      boardPath: absoluteBoardPath,
      origin,
      sourceLocation: null,
      state: 'active',
      organization,
      position: Math.max(0, ...workspace.projects.map((candidate) => candidate.position || 0)) + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
    workspace.projects.push(project);
    await writeWorkspace(filePath, workspace);
    return { filePath, workspace, project, unchanged: false };
  });
}

export async function createWorkspaceProject(filePath, { name, boardPath, organization = 'Unsorted', origin = 'manual' }) {
  if (!name?.trim()) throw new Error('A project name is required.');
  if (!boardPath?.trim()) throw new Error('A project board path is required.');
  const absoluteBoardPath = absolutePath(boardPath);
  const board = await (await pathExists(path.join(absoluteBoardPath, '.crewboard', 'board.json'))
    ? BoardStore.open(absoluteBoardPath)
    : BoardStore.initialize(absoluteBoardPath, { name: name.trim() }));
  const result = await addBoardToWorkspace(filePath, absoluteBoardPath, { origin, organization });
  if (result.project.name !== name.trim()) {
    await renameWorkspaceProject(filePath, result.project.id, name.trim());
    result.project.name = name.trim();
  }
  return { ...result, board: board.config };
}

export async function discoverProjects(filePath, options) {
  const discovery = await discoverProjectCandidates(options);
  return withWorkspaceLock(filePath, async () => {
    const { workspace } = await openWorkspaceUnlocked(filePath);
    const known = new Set(workspace.projects.map(projectKey));
    const added = [];
    for (const candidate of discovery.candidates) {
      const normalized = normalizeProject({
        ...candidate,
        id: generatedProjectId(`${candidate.origin}:${candidate.path || candidate.sourceLocation}:${candidate.sourceId || candidate.name}`),
        state: 'pending',
        organization: 'Unsorted',
        position: Math.max(0, ...workspace.projects.map((project) => project.position || 0)) + added.length + 1,
        createdAt: now(),
        updatedAt: now(),
      }, workspace.projects.length + added.length);
      if (known.has(projectKey(normalized))) continue;
      known.add(projectKey(normalized));
      workspace.projects.push(normalized);
      added.push(normalized);
    }
    if (added.length) await writeWorkspace(filePath, workspace);
    return {
      filePath,
      source: options.source,
      sourceFound: discovery.sourceFound,
      sourceLocation: discovery.sourceLocation,
      discovered: added,
      pendingProjects: sortProjects(workspace.projects.filter((project) => project.state === 'pending')),
    };
  });
}

export async function approveWorkspaceProject(filePath, projectId, { boardPath = null } = {}) {
  return withWorkspaceLock(filePath, async () => {
    const { workspace } = await openWorkspaceUnlocked(filePath);
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.state === 'archived') throw new Error('Restore an archived project before approving it.');
    const targetPath = absolutePath(boardPath || project.boardPath || project.path);
    if (!targetPath) throw new Error(`Project ${project.name} needs a local board path before approval.`);
    if (await pathExists(path.join(targetPath, '.crewboard', 'board.json'))) await BoardStore.open(targetPath);
    else await BoardStore.initialize(targetPath, { name: project.name });
    project.path = project.path || targetPath;
    project.boardPath = targetPath;
    project.state = 'active';
    project.archivedAt = null;
    project.updatedAt = now();
    await writeWorkspace(filePath, workspace);
    return { filePath, project };
  });
}

export async function renameWorkspaceProject(filePath, projectId, name) {
  if (!name?.trim()) throw new Error('A project name is required.');
  return withWorkspaceLock(filePath, async () => {
    const { workspace } = await openWorkspaceUnlocked(filePath);
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    project.name = name.trim();
    project.updatedAt = now();
    await writeWorkspace(filePath, workspace);
    return { filePath, project };
  });
}

export async function updateWorkspaceProject(filePath, projectId, { organization, state } = {}) {
  return withWorkspaceLock(filePath, async () => {
    const { workspace } = await openWorkspaceUnlocked(filePath);
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (organization !== undefined) project.organization = organization.trim() || 'Unsorted';
    if (state !== undefined) {
      if (!['active', 'archived', 'pending'].includes(state)) throw new Error('Project state must be active, archived, or pending.');
      if (state === 'pending') throw new Error('Projects can only become pending through discovery or import.');
      if (project.state === 'pending') throw new Error('Pending projects must be approved before they can be archived or restored.');
      if (state === 'active' && project.state !== 'archived') throw new Error('Only archived projects can be restored.');
      if (state === 'archived' && project.state !== 'active') throw new Error('Only active projects can be archived.');
      project.state = state;
      project.archivedAt = state === 'archived' ? now() : null;
    }
    project.updatedAt = now();
    await writeWorkspace(filePath, workspace);
    return { filePath, project };
  });
}

export async function arrangeWorkspaceProject(filePath, projectId, direction) {
  if (!['up', 'down'].includes(direction)) throw new Error('Project arrangement direction must be up or down.');
  return withWorkspaceLock(filePath, async () => {
    const { workspace } = await openWorkspaceUnlocked(filePath);
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const arranged = sortProjects(workspace.projects.filter((candidate) => candidate.state === project.state));
    const index = arranged.findIndex((candidate) => candidate.id === projectId);
    const neighbor = arranged[index + (direction === 'up' ? -1 : 1)];
    if (!neighbor) return { filePath, project, unchanged: true };
    [project.position, neighbor.position] = [neighbor.position, project.position];
    project.updatedAt = now();
    neighbor.updatedAt = now();
    await writeWorkspace(filePath, workspace);
    return { filePath, project, unchanged: false };
  });
}

export async function listWorkspace(filePath) {
  const { workspace } = await openWorkspace(filePath);
  const records = sortProjects(workspace.projects);
  const activeRecords = records.filter((project) => project.state === 'active');
  const projects = await Promise.all(activeRecords.map(async (project) => {
    try {
      const board = await BoardStore.open(project.boardPath);
      return { ...project, columns: board.config.columns, tickets: await board.listTickets(), available: true };
    } catch (error) {
      return { ...project, columns: [], tickets: [], available: false, error: error.message };
    }
  }));
  return {
    filePath,
    workspace,
    projects,
    pendingProjects: records.filter((project) => project.state === 'pending'),
    archivedProjects: records.filter((project) => project.state === 'archived'),
  };
}
