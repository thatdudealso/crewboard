import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BoardStore, transferTicket } from '../src/store.js';
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

  assert.match(ticket.id, /^CB-\d{20,}$/);
  assert.deepEqual(ticket.labels, ['release', 'agent']);
  assert.equal(event.cursor, 1);
  const persisted = await fs.readFile(path.join(root, '.crewboard', 'tickets', `${ticket.id}.md`), 'utf8');
  assert.match(persisted, new RegExp(`^---\\nschemaVersion: 1\\nid: "${ticket.id}"`));
  assert.match(persisted, /<!-- crewboard-messages/);

  const reopened = await BoardStore.open(root);
  const found = await reopened.getTicket(ticket.id);
  assert.equal(found.title, 'Launch crewboard');
  assert.equal(found.assignee, 'builder');
  assert.deepEqual((await reopened.activity(0)).events.map((item) => item.action), ['ticket-created']);
});

test('a ticket body can contain the reserved message marker literally', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const body = 'Keep <!-- crewboard-messages\nthis literal marker in Markdown.';
  const { ticket } = await board.createTicket({ title: 'Document storage syntax', body });

  assert.equal((await board.getTicket(ticket.id)).body, body);
});

test('a board enforces configured lifecycle columns', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root, { columns: ['queued', 'working', 'shipped'] });
  const { ticket } = await board.createTicket({ title: 'Coordinate release', status: 'queued' });
  const moved = await board.moveTicket(ticket.id, 'working', { actor: 'agent-a' });

  assert.equal(moved.ticket.status, 'working');
  await assert.rejects(() => board.moveTicket(ticket.id, 'missing'), /Unknown status/);
});

test('ticket state transitions remain in the ticket status history', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const { ticket } = await board.createTicket({ title: 'Preserve status evidence', actor: 'triage' });
  await board.moveTicket(ticket.id, 'active', { actor: 'builder', note: 'Implementation started' });

  const persisted = await board.getTicket(ticket.id);
  assert.deepEqual(persisted.statusHistory.map((entry) => entry.status), ['inbox', 'active']);
  assert.equal(persisted.statusHistory.at(-1).note, 'Implementation started');
});

test('open board handles refresh their cursors before recording later mutations', async () => {
  const root = await temporaryDirectory();
  const firstHandle = await BoardStore.initialize(root);
  const first = await firstHandle.createTicket({ title: 'First task' });
  const secondHandle = await BoardStore.open(root);
  await secondHandle.addComment(first.ticket.id, { author: 'worker', body: 'A durable update.' });
  const second = await firstHandle.createTicket({ title: 'Second task' });

  assert.match(second.ticket.id, /^CB-\d{20,}$/);
  assert.deepEqual((await firstHandle.activity(0)).events.map((event) => event.cursor), [1, 2, 3]);
});

test('simultaneous agents receive unique ticket IDs and activity cursors', async () => {
  const root = await temporaryDirectory();
  await BoardStore.initialize(root);
  const handles = await Promise.all(Array.from({ length: 5 }, () => BoardStore.open(root)));
  const created = await Promise.all(handles.map((board, index) => board.createTicket({ title: `Concurrent task ${index + 1}` })));

  assert.equal(new Set(created.map((result) => result.ticket.id)).size, 5);
  assert.ok(created.every((result) => /^CB-\d{20,}$/.test(result.ticket.id)));
  const board = await BoardStore.open(root);
  assert.deepEqual((await board.activity()).events.map((event) => event.cursor), [1, 2, 3, 4, 5]);
});

test('simultaneous board initialization has one successful owner', async () => {
  const root = await temporaryDirectory();

  const attempts = await Promise.allSettled([
    BoardStore.initialize(root, { name: 'First board' }),
    BoardStore.initialize(root, { name: 'Second board' }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.match(attempts.find((attempt) => attempt.status === 'rejected').reason.message, /Crewboard already exists/);
  assert.ok((await BoardStore.open(root)).config.name === 'First board' || (await BoardStore.open(root)).config.name === 'Second board');
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
  assert.match(activity.cursor, /^v1\./);
  assert.equal(activity.events[0].action, 'ticket-created');
});

test('a board recovers a mutation lock left by a stopped process', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  await fs.writeFile(path.join(root, '.crewboard', '.mutation.lock'), JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));

  const { ticket } = await board.createTicket({ title: 'Recover mutations' });

  assert.match(ticket.id, /^CB-\d{20,}$/);
});

test('a board recovers an orphaned stale-lock recovery sentinel', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const lockPath = path.join(root, '.crewboard', '.mutation.lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));
  await fs.writeFile(`${lockPath}.recovery`, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));

  const { ticket } = await board.createTicket({ title: 'Recover handoff' });

  assert.match(ticket.id, /^CB-\d{20,}$/);
});

test('activity ignores an unfinished trailing event record', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  await board.createTicket({ title: 'Published event' });
  await fs.appendFile(path.join(root, '.crewboard', 'events.jsonl'), '{"cursor":2');

  const activity = await board.activity(0);

  assert.match(activity.cursor, /^v1\./);
  assert.deepEqual(activity.events.map((event) => event.cursor), [1]);
});

test('the next mutation repairs an unfinished event record before appending', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  await board.createTicket({ title: 'Published event' });
  await fs.appendFile(path.join(root, '.crewboard', 'events.jsonl'), '{"cursor":2');

  await board.createTicket({ title: 'Recovered event stream' });

  assert.deepEqual((await board.activity(0)).events.map((event) => event.cursor), [1, 2]);
});

test('a complete final event without a newline remains durable', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  await board.createTicket({ title: 'Published event' });
  await fs.appendFile(path.join(root, '.crewboard', 'events.jsonl'), JSON.stringify({
    cursor: 2,
    at: '2026-01-01T00:00:00.000Z',
    action: 'merged-event',
    ticketId: null,
    actor: null,
    data: {},
  }));

  assert.deepEqual((await board.activity(0)).events.map((event) => event.action), ['ticket-created', 'merged-event']);
  await board.createTicket({ title: 'Later event' });
  assert.deepEqual((await board.activity(0)).events.map((event) => event.cursor), [1, 2, 3]);
});

test('merged branch activity and ticket files preserve every creation', async () => {
  const root = await temporaryDirectory();
  const basePath = path.join(root, 'base');
  const firstBranchPath = path.join(root, 'first');
  const secondBranchPath = path.join(root, 'second');
  const mergedPath = path.join(root, 'merged');
  const base = await BoardStore.initialize(basePath);
  await base.createTicket({ title: 'Base ticket' });
  await Promise.all([firstBranchPath, secondBranchPath, mergedPath].map((branchPath) => fs.cp(basePath, branchPath, { recursive: true })));

  const first = await BoardStore.open(firstBranchPath);
  const second = await BoardStore.open(secondBranchPath);
  const firstTicket = await first.createTicket({ title: 'First branch ticket' });
  const firstCheckpoint = (await first.activity(0)).cursor;
  const secondTicket = await second.createTicket({ title: 'Second branch ticket' });
  await Promise.all([firstTicket, secondTicket].map(({ ticket }, index) => fs.copyFile(
    path.join(index === 0 ? firstBranchPath : secondBranchPath, '.crewboard', 'tickets', `${ticket.id}.md`),
    path.join(mergedPath, '.crewboard', 'tickets', `${ticket.id}.md`),
  )));
  const firstEvents = (await fs.readFile(path.join(firstBranchPath, '.crewboard', 'events.jsonl'), 'utf8')).trim().split('\n');
  const secondEvents = (await fs.readFile(path.join(secondBranchPath, '.crewboard', 'events.jsonl'), 'utf8')).trim().split('\n');
  await fs.writeFile(path.join(mergedPath, '.crewboard', 'events.jsonl'), `${[firstEvents[0], firstEvents[1], secondEvents[1]].join('\n')}\n`);

  const merged = await BoardStore.open(mergedPath);
  assert.deepEqual((await merged.activity(1)).events.map((event) => event.action), ['ticket-created', 'ticket-created']);
  assert.deepEqual((await merged.activity(firstCheckpoint)).events.map((event) => event.ticketId), [secondTicket.ticket.id]);
  assert.deepEqual((await merged.activity(0)).events.map((event) => event.cursor), [1, 2, 3]);
  await merged.createTicket({ title: 'Merged ticket' });
  assert.equal((await merged.listTickets()).length, 4);
  assert.deepEqual((await merged.activity(0)).events.map((event) => event.cursor), [1, 2, 3, 4]);
});

test('an activity checkpoint remains compact after sequential mutations', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  for (let index = 0; index < 12; index += 1) await board.createTicket({ title: `Ticket ${index + 1}` });

  const checkpoint = (await board.activity()).cursor;
  assert.ok(checkpoint.length < 100);
  assert.deepEqual((await board.activity(checkpoint)).events, []);
});

test('a ticket can move across projects while preserving its conversation', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const { ticket } = await source.createTicket({ title: 'Move me', body: 'Context travels.', labels: ['handoff'] });
  await source.addComment(ticket.id, { author: 'builder', body: 'Ready to transfer.' });

  const transferred = await transferTicket(source, destination, ticket.id, { destinationProjectId: 'project-destination', actor: 'captain-web' });

  assert.equal(transferred.ticket.title, 'Move me');
  assert.equal(transferred.ticket.messages.length, 1);
  assert.equal((await destination.listTickets()).length, 1);
  assert.equal((await source.listTickets()).length, 0);
  assert.equal((await source.getTicket(ticket.id)).transferredTo.ticketId, transferred.ticket.id);
});

test('a failed source archival leaves a recoverable inactive transfer copy', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const { ticket } = await source.createTicket({ title: 'Recover transfer' });
  const archiveTicketUnlocked = source.archiveTicketUnlocked.bind(source);
  source.archiveTicketUnlocked = async () => { throw new Error('Source write failed.'); };

  await assert.rejects(() => transferTicket(source, destination, ticket.id), /Source write failed/);
  assert.equal((await source.listTickets()).length, 1);
  assert.equal((await destination.listTickets()).length, 0);
  assert.equal((await destination.listTickets({ includeArchived: true })).length, 1);

  source.archiveTicketUnlocked = archiveTicketUnlocked;
  const transferred = await transferTicket(source, destination, ticket.id);
  assert.equal((await source.listTickets()).length, 0);
  assert.equal((await destination.listTickets()).length, 1);
  assert.equal(transferred.ticket.title, 'Recover transfer');
});
