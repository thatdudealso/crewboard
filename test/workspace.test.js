import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BoardStore } from '../src/store.js';
import { addBoardToWorkspace, approveWorkspaceProject, discoverProjects, initializeWorkspace, listWorkspace, renameWorkspaceProject, updateWorkspaceProject } from '../src/workspace.js';
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

test('discovered projects retain provenance and wait for captain approval', async () => {
  const root = await temporaryDirectory();
  const sourceRoot = path.join(root, 'projects');
  const discoveredPath = path.join(sourceRoot, 'scoopies');
  const workspace = path.join(root, 'fleet-workspace.json');
  await fs.mkdir(path.join(discoveredPath, '.git'), { recursive: true });
  await initializeWorkspace(workspace);

  const discovery = await discoverProjects(workspace, { source: 'local', root: sourceRoot });

  assert.equal(discovery.sourceFound, true);
  assert.equal(discovery.discovered.length, 1);
  assert.equal(discovery.discovered[0].origin, 'local');
  assert.equal((await listWorkspace(workspace)).projects.length, 0);
  await assert.rejects(() => updateWorkspaceProject(workspace, discovery.discovered[0].id, { state: 'active' }), /must be approved/);
  assert.equal((await listWorkspace(workspace)).pendingProjects.length, 1);
  const approved = await approveWorkspaceProject(workspace, discovery.discovered[0].id);
  await renameWorkspaceProject(workspace, approved.project.id, 'Scoopies');
  await updateWorkspaceProject(workspace, approved.project.id, { organization: 'Fleet work' });

  const listed = await listWorkspace(workspace);
  assert.equal(listed.projects[0].name, 'Scoopies');
  assert.equal(listed.projects[0].origin, 'local');
  assert.equal(listed.projects[0].organization, 'Fleet work');
  assert.equal(listed.pendingProjects.length, 0);
  assert.equal((await BoardStore.open(discoveredPath)).config.name, 'scoopies');
});

test('only approved archived projects can be restored', async () => {
  const root = await temporaryDirectory();
  const boardPath = path.join(root, 'project');
  const workspace = path.join(root, 'fleet-workspace.json');
  await BoardStore.initialize(boardPath, { name: 'Project' });
  await initializeWorkspace(workspace);
  const project = (await addBoardToWorkspace(workspace, boardPath)).project;

  await updateWorkspaceProject(workspace, project.id, { state: 'archived' });
  await updateWorkspaceProject(workspace, project.id, { state: 'active' });
  await assert.rejects(() => updateWorkspaceProject(workspace, project.id, { state: 'active' }), /Only archived projects can be restored/);
});

test('an unavailable ChatGPT export reports a real no-source state', async () => {
  const root = await temporaryDirectory();
  const workspace = path.join(root, 'fleet-workspace.json');
  await initializeWorkspace(workspace);

  const discovery = await discoverProjects(workspace, { source: 'chatgpt', root: path.join(root, 'missing-export.json') });

  assert.equal(discovery.sourceFound, false);
  assert.deepEqual(discovery.discovered, []);
  assert.equal((await listWorkspace(workspace)).pendingProjects.length, 0);
});

test('a local ChatGPT export becomes pending project records with chatgpt provenance', async () => {
  const root = await temporaryDirectory();
  const workspace = path.join(root, 'fleet-workspace.json');
  const exportPath = path.join(root, 'chatgpt-projects.json');
  await fs.writeFile(exportPath, JSON.stringify({ projects: [{ name: 'Research notes' }] }));
  await initializeWorkspace(workspace);

  const discovery = await discoverProjects(workspace, { source: 'chatgpt', root: exportPath });

  assert.equal(discovery.sourceFound, true);
  assert.equal(discovery.discovered[0].origin, 'chatgpt');
  assert.equal((await listWorkspace(workspace)).pendingProjects[0].name, 'Research notes');
});
