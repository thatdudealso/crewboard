import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardStore, transferTicket } from './store.js';
import {
  approveWorkspaceProject,
  arrangeWorkspaceProject,
  createWorkspaceProject,
  discoverProjects,
  ensureWorkspace,
  getProjectRecord,
  listWorkspace,
  renameWorkspaceProject,
  updateWorkspaceProject,
} from './workspace.js';

const DEFAULT_PORT = 3737;
const UI_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-ui');

function send(response, status, body, contentType = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, `${JSON.stringify(body)}\n`, 'application/json; charset=utf-8');
}

function assertCsrf(request, csrfToken) {
  if (request.headers['x-crewboard-csrf'] === csrfToken) return;
  const error = new Error('Invalid CSRF token.');
  error.statusCode = 403;
  throw error;
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function pathParts(requestUrl) {
  return new URL(requestUrl, 'http://127.0.0.1').pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

async function boardForProject(workspaceFile, projectId) {
  const project = await getProjectRecord(workspaceFile, projectId);
  if (project.state !== 'active') throw new Error(`Project ${project.name} is not approved yet.`);
  if (!project.boardPath) throw new Error(`Project ${project.name} has no board path.`);
  return { project, board: await BoardStore.open(project.boardPath) };
}

function editableTicketChanges(body) {
  const changes = {};
  for (const key of ['title', 'body', 'status', 'assignee', 'priority']) {
    if (body[key] !== undefined) changes[key] = body[key];
  }
  if (body.labels !== undefined) changes.labels = Array.isArray(body.labels) ? body.labels : String(body.labels).split(',');
  if (body.links !== undefined) changes.links = Array.isArray(body.links) ? body.links : String(body.links).split(',');
  if (changes.assignee === '') changes.assignee = null;
  return changes;
}

async function snapshot(workspaceFile) {
  const listed = await listWorkspace(workspaceFile);
  return {
    workspace: listed.workspace,
    projects: listed.projects,
    pendingProjects: listed.pendingProjects,
    archivedProjects: listed.archivedProjects,
  };
}

async function api(request, response, workspaceFile, csrfToken) {
  if (request.method !== 'GET') assertCsrf(request, csrfToken);
  const parts = pathParts(request.url);
  if (request.method === 'GET' && parts.join('/') === 'api/board') return sendJson(response, 200, await snapshot(workspaceFile));
  if (request.method === 'POST' && parts.join('/') === 'api/projects/discover') {
    const body = await readBody(request);
    return sendJson(response, 200, await discoverProjects(workspaceFile, body));
  }
  if (request.method === 'POST' && parts.join('/') === 'api/projects') {
    return sendJson(response, 201, await createWorkspaceProject(workspaceFile, await readBody(request)));
  }
  if (parts[0] !== 'api' || parts[1] !== 'projects' || !parts[2]) return sendJson(response, 404, { error: { message: 'Unknown API route.' } });
  const projectId = parts[2];
  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'approve') {
    return sendJson(response, 200, await approveWorkspaceProject(workspaceFile, projectId, await readBody(request)));
  }
  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'arrange') {
    const body = await readBody(request);
    return sendJson(response, 200, await arrangeWorkspaceProject(workspaceFile, projectId, body.direction));
  }
  if (request.method === 'PATCH' && parts.length === 3) {
    const body = await readBody(request);
    if (body.name !== undefined) return sendJson(response, 200, await renameWorkspaceProject(workspaceFile, projectId, body.name));
    return sendJson(response, 200, await updateWorkspaceProject(workspaceFile, projectId, body));
  }
  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'tickets') {
    const body = await readBody(request);
    const { board } = await boardForProject(workspaceFile, projectId);
    return sendJson(response, 201, await board.createTicket({
      ...editableTicketChanges(body),
      actor: body.actor || 'captain-web',
    }));
  }
  if (parts[3] !== 'tickets' || !parts[4]) return sendJson(response, 404, { error: { message: 'Unknown project API route.' } });
  const ticketId = parts[4];
  const { board } = await boardForProject(workspaceFile, projectId);
  if (request.method === 'PATCH' && parts.length === 5) {
    const body = await readBody(request);
    return sendJson(response, 200, await board.updateTicket(ticketId, editableTicketChanges(body), {
      action: 'ticket-edited',
      actor: body.actor || 'captain-web',
      eventData: { fields: Object.keys(editableTicketChanges(body)) },
    }));
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'messages') {
    const body = await readBody(request);
    return sendJson(response, 201, await board.addComment(ticketId, {
      author: body.author || 'captain-web',
      body: body.body,
      mentions: body.mentions || [],
      replyTo: body.replyTo || null,
    }));
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'reorder') {
    const body = await readBody(request);
    return sendJson(response, 200, await board.reorderTickets(body.ticketIds, { status: body.status, actor: body.actor || 'captain-web' }));
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'transfer') {
    const body = await readBody(request);
    const destination = await boardForProject(workspaceFile, body.destinationProjectId);
    return sendJson(response, 200, await transferTicket(board, destination.board, ticketId, {
      destinationProjectId: destination.project.id,
      actor: body.actor || 'captain-web',
    }));
  }
  return sendJson(response, 404, { error: { message: 'Unknown ticket API route.' } });
}

function page(csrfToken) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crewboard</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">Crewboard <span class="live">LIVE</span></div>
    <div class="nav-label">Views</div>
    <button class="nav-button active" data-view="board">Board</button>
    <button class="nav-button" data-view="messages">Message board</button>
    <button class="nav-button" data-view="projects">Projects</button>
    <div class="nav-label">Active projects</div>
    <div id="project-nav"></div>
    <div class="nav-label">Pending approval</div>
    <div id="pending-nav"></div>
  </aside>
  <main class="main"><div id="app"></div></main>
</div>
<div class="modal-backdrop" id="modal-backdrop"><section class="modal" id="modal"></section></div>
<script>window.CREWBOARD_CSRF = ${JSON.stringify(csrfToken)};</script>
<script src="/assets/app.js"></script>
</body>
</html>`;
}

async function staticAsset(parts, response) {
  if (parts[0] !== 'assets' || parts.length !== 2) return false;
  const file = parts[1];
  if (!['app.css', 'app.js'].includes(file)) return false;
  const contents = await fs.readFile(path.join(UI_DIRECTORY, file));
  send(response, 200, contents, file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
  return true;
}

export async function startWebServer({ cwd = process.cwd(), workspaceFile = 'crewboard-workspace.json', port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const resolvedWorkspace = path.resolve(cwd, workspaceFile);
  const csrfToken = crypto.randomBytes(32).toString('hex');
  await ensureWorkspace(resolvedWorkspace);
  const server = http.createServer(async (request, response) => {
    try {
      const parts = pathParts(request.url);
      if (request.method === 'GET' && await staticAsset(parts, response)) return;
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname === '/' && request.method === 'GET') return send(response, 200, page(csrfToken));
      if (pathname.startsWith('/api/')) return await api(request, response, resolvedWorkspace, csrfToken);
      return send(response, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: { message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  const address = server.address();
  return { server, workspaceFile: resolvedWorkspace, url: `http://${host}:${address.port}`, csrfToken };
}
