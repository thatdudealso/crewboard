import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BoardStore } from '../src/store.js';
import { addBoardToWorkspace, initializeWorkspace, listWorkspace } from '../src/workspace.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('a workspace registers boards and returns a cross-project ticket view', async () => {
  const root = await temporaryDirectory();
  const api = path.join(root, 'api');
  const web = path.join(root, 'web');
  const workspace = path.join(root, 'fleet-workspace.json');
  const apiBoard = await BoardStore.initialize(api, { name: 'API' });
  const webBoard = await BoardStore.initialize(web, { name: 'Web' });
  await apiBoard.createTicket({ title: 'Publish contract' });
  await webBoard.createTicket({ title: 'Wire client' });

  await initializeWorkspace(workspace);
  await addBoardToWorkspace(workspace, api);
  await addBoardToWorkspace(workspace, web);
  const result = await listWorkspace(workspace);

  assert.deepEqual(result.projects.map((project) => project.name), ['API', 'Web']);
  assert.deepEqual(result.projects.map((project) => project.tickets[0].title), ['Publish contract', 'Wire client']);
});

test('simultaneous workspace registrations preserve every project', async () => {
  const root = await temporaryDirectory();
  const api = path.join(root, 'api');
  const web = path.join(root, 'web');
  const workspace = path.join(root, 'fleet-workspace.json');
  await BoardStore.initialize(api, { name: 'API' });
  await BoardStore.initialize(web, { name: 'Web' });
  await initializeWorkspace(workspace);

  await Promise.all([addBoardToWorkspace(workspace, api), addBoardToWorkspace(workspace, web)]);

  const result = await listWorkspace(workspace);
  assert.deepEqual(result.projects.map((project) => project.name).sort(), ['API', 'Web']);
});

test('a workspace recovers a lock left by a stopped process', async () => {
  const root = await temporaryDirectory();
  const boardPath = path.join(root, 'api');
  const workspace = path.join(root, 'fleet-workspace.json');
  await BoardStore.initialize(boardPath, { name: 'API' });
  await initializeWorkspace(workspace);
  await fs.writeFile(`${workspace}.lock`, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));

  await addBoardToWorkspace(workspace, boardPath);

  assert.equal((await listWorkspace(workspace)).projects[0].name, 'API');
});
