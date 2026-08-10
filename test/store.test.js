import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BoardStore } from '../src/store.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('a board persists git-friendly markdown tickets and append-only events', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root, { name: 'Flight control' });
  const { ticket, event } = await board.createTicket({
    title: 'Launch crewboard',
    body: 'Ship the first fleet board.',
    assignee: 'builder',
    labels: ['release,agent', 'agent'],
    priority: 'high',
    links: ['README.md', 'https://example.test/pr/1'],
    actor: 'captain',
  });

  assert.equal(ticket.id, 'CB-0001');
  assert.deepEqual(ticket.labels, ['release', 'agent']);
  assert.equal(event.cursor, 1);
  const persisted = await fs.readFile(path.join(root, '.crewboard', 'tickets', 'CB-0001.md'), 'utf8');
  assert.match(persisted, /^---\nschemaVersion: 1\nid: "CB-0001"/);
  assert.match(persisted, /<!-- crewboard-messages/);

  const reopened = await BoardStore.open(root);
  const found = await reopened.getTicket('CB-0001');
  assert.equal(found.title, 'Launch crewboard');
  assert.equal(found.assignee, 'builder');
  assert.deepEqual((await reopened.activity(0)).events.map((item) => item.action), ['ticket-created']);
});

test('a board enforces configured lifecycle columns', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root, { columns: ['queued', 'working', 'shipped'] });
  const { ticket } = await board.createTicket({ title: 'Coordinate release', status: 'queued' });
  const moved = await board.moveTicket(ticket.id, 'working', { actor: 'agent-a' });

  assert.equal(moved.ticket.status, 'working');
  await assert.rejects(() => board.moveTicket(ticket.id, 'missing'), /Unknown status/);
});

test('open board handles refresh their cursors before recording later mutations', async () => {
  const root = await temporaryDirectory();
  const firstHandle = await BoardStore.initialize(root);
  const first = await firstHandle.createTicket({ title: 'First task' });
  const secondHandle = await BoardStore.open(root);
  await secondHandle.addComment(first.ticket.id, { author: 'worker', body: 'A durable update.' });
  const second = await firstHandle.createTicket({ title: 'Second task' });

  assert.equal(second.ticket.id, 'CB-0002');
  assert.deepEqual((await firstHandle.activity(0)).events.map((event) => event.cursor), [1, 2, 3]);
});

test('simultaneous agents receive unique ticket IDs and activity cursors', async () => {
  const root = await temporaryDirectory();
  await BoardStore.initialize(root);
  const handles = await Promise.all(Array.from({ length: 5 }, () => BoardStore.open(root)));
  const created = await Promise.all(handles.map((board, index) => board.createTicket({ title: `Concurrent task ${index + 1}` })));

  assert.deepEqual(created.map((result) => result.ticket.id).sort(), ['CB-0001', 'CB-0002', 'CB-0003', 'CB-0004', 'CB-0005']);
  const board = await BoardStore.open(root);
  assert.deepEqual((await board.activity()).events.map((event) => event.cursor), [1, 2, 3, 4, 5]);
});

test('activity derives its polling cursor from durable events', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  await board.createTicket({ title: 'Durable activity' });
  const configPath = path.join(root, '.crewboard', 'board.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.lastEventCursor = 0;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const activity = await BoardStore.open(root).then((reopened) => reopened.activity(0));
  assert.equal(activity.cursor, 1);
  assert.equal(activity.events[0].action, 'ticket-created');
});
