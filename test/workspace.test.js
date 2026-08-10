import assert from 'node:assert/strict';
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
