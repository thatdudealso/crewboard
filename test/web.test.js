import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startWebServer } from '../src/web.js';
import { temporaryDirectory } from '../test-support/helpers.js';

async function request(url, method = 'GET', body, csrfToken) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json', 'x-crewboard-csrf': csrfToken } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  assert.ok(response.ok, typeof payload === 'string' ? payload : payload.error?.message);
  return payload;
}

test('the web board exposes a lazy GitHub attention endpoint without blocking board snapshot', async () => {
  const root = await temporaryDirectory();
  const workspaceFile = path.join(root, 'fleet-workspace.json');
  await fs.writeFile(workspaceFile, `${JSON.stringify({
    schemaVersion: 2,
    projects: [],
    githubAttention: { repos: ['thatdudealso/crewboard'], login: 'thatdudealso' },
  }, null, 2)}\n`);
  const { server, url } = await startWebServer({ cwd: root, workspaceFile, port: 0 });
  try {
    const board = await request(`${url}/api/board`);
    assert.ok(Array.isArray(board.projects));
    const page = await request(`${url}/`);
    assert.match(page, /data-view="attention"/);
    assert.match(page, /data-refresh-attention/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('the local web controller creates and moves tickets through the shared workspace store', async () => {
  const root = await temporaryDirectory();
  const workspaceFile = path.join(root, 'fleet-workspace.json');
  const { server, url, csrfToken } = await startWebServer({ cwd: root, workspaceFile, port: 0 });
  try {
    const crossOrigin = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'Attacker project', boardPath: path.join(root, 'attacker') }),
    });
    assert.equal(crossOrigin.status, 403);
    const source = await request(`${url}/api/projects`, 'POST', { name: 'Source', boardPath: path.join(root, 'source') }, csrfToken);
    const destination = await request(`${url}/api/projects`, 'POST', { name: 'Destination', boardPath: path.join(root, 'destination') }, csrfToken);
    const ticket = await request(`${url}/api/projects/${source.project.id}/tickets`, 'POST', {
      title: 'Move through the web board',
      body: 'Acceptance: preserve the threaded handoff.',
      status: 'inbox',
    }, csrfToken);
    const emptyTitle = await fetch(`${url}/api/projects/${source.project.id}/tickets/${ticket.ticket.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-crewboard-csrf': csrfToken },
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(emptyTitle.status, 400);
    assert.match((await emptyTitle.json()).error.message, /ticket title is required/i);
    const emptyStatus = await fetch(`${url}/api/projects/${source.project.id}/tickets/${ticket.ticket.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-crewboard-csrf': csrfToken },
      body: JSON.stringify({ status: '' }),
    });
    assert.equal(emptyStatus.status, 400);
    assert.match((await emptyStatus.json()).error.message, /Unknown status/);
    await request(`${url}/api/projects/${source.project.id}/tickets/${ticket.ticket.id}/messages`, 'POST', { body: 'Ready to hand off.' }, csrfToken);
    await request(`${url}/api/projects/${source.project.id}/tickets/${ticket.ticket.id}/transfer`, 'POST', {
      destinationProjectId: destination.project.id,
    }, csrfToken);

    const board = await request(`${url}/api/board`);
    assert.equal(board.projects.find((project) => project.id === source.project.id).tickets.length, 0);
    const moved = board.projects.find((project) => project.id === destination.project.id).tickets[0];
    assert.equal(moved.title, 'Move through the web board');
    assert.equal(moved.messages[0].body, 'Ready to hand off.');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('the web board serves its UI assets', async () => {
  const root = await temporaryDirectory();
  const workspaceFile = path.join(root, 'fleet-workspace.json');
  const { server, url } = await startWebServer({ cwd: root, workspaceFile, port: 0 });
  try {
    const html = await request(`${url}/`);
    assert.match(html, /assets\/app\.css/);
    assert.match(html, /assets\/app\.js/);

    const css = await fetch(`${url}/assets/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') || '', /text\/css/);
    const cssText = await css.text();
    assert.ok(cssText.length > 500, 'css payload should be non-trivial');

    const js = await fetch(`${url}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);
    const jsText = await js.text();
    assert.ok(jsText.length > 500, 'js payload should be non-trivial');

    const missing = await fetch(`${url}/assets/%2e%2e%2fweb.js`);
    assert.equal(missing.status, 404);
    const unknown = await fetch(`${url}/assets/not-a-real-asset.css`);
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
