import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

  assert.match(ticket.id, /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/);
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

  assert.match(second.ticket.id, /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/);
  assert.deepEqual((await firstHandle.activity(0)).events.map((event) => event.cursor), [1, 2, 3]);
});

test('simultaneous agents receive unique ticket IDs and activity cursors', async () => {
  const root = await temporaryDirectory();
  await BoardStore.initialize(root);
  const handles = await Promise.all(Array.from({ length: 5 }, () => BoardStore.open(root)));
  const created = await Promise.all(handles.map((board, index) => board.createTicket({ title: `Concurrent task ${index + 1}` })));

  assert.equal(new Set(created.map((result) => result.ticket.id)).size, 5);
  assert.ok(created.every((result) => /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/.test(result.ticket.id)));
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

  assert.match(ticket.id, /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/);
});

test('a board recovers an orphaned stale-lock recovery sentinel', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const lockPath = path.join(root, '.crewboard', '.mutation.lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));
  await fs.writeFile(`${lockPath}.recovery`, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));

  const { ticket } = await board.createTicket({ title: 'Recover handoff' });

  assert.match(ticket.id, /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/);
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
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'crewboard@example.test');
  git('config', 'user.name', 'Crewboard test');
  const base = await BoardStore.initialize(root);
  await base.createTicket({ title: 'Base ticket' });
  git('add', '.');
  git('commit', '-m', 'base board');
  const baseBranch = git('branch', '--show-current').trim();

  git('switch', '-c', 'first');
  const first = await BoardStore.open(root);
  const firstTicket = await first.createTicket({ title: 'First branch ticket' });
  const firstCheckpoint = (await first.activity(0)).cursor;
  git('add', '.');
  git('commit', '-m', 'first board change');

  git('switch', '-c', 'second', baseBranch);
  const second = await BoardStore.open(root);
  const secondTicket = await second.createTicket({ title: 'Second branch ticket' });
  git('add', '.');
  git('commit', '-m', 'second board change');

  git('switch', 'first');
  git('merge', '--no-edit', 'second');

  const merged = await BoardStore.open(root);
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

test('an activity checkpoint handles a deep event ancestry', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const events = Array.from({ length: 20_000 }, (_, index) => ({
    id: `e-${index + 1}`,
    parents: index ? [`e-${index}`] : [],
    cursor: index + 1,
    at: '2026-01-01T00:00:00.000Z',
    action: 'ticket-created',
    ticketId: null,
    actor: null,
    data: {},
  }));
  await fs.writeFile(path.join(root, '.crewboard', 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const checkpoint = `v1.${Buffer.from(JSON.stringify(['e-20000'])).toString('base64url')}`;

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

test('transferring a parent moves its hierarchy with remapped parent links', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Moving story', type: 'story' });
  const task = await source.createTicket({ title: 'Moving task', type: 'task', parent: story.ticket.id });
  const subtask = await source.createTicket({ title: 'Moving subtask', type: 'subtask', parent: task.ticket.id });

  const transferred = await transferTicket(source, destination, story.ticket.id, { destinationProjectId: 'project-destination', actor: 'captain-web' });
  const destinationTickets = await destination.listTickets();
  const destinationTask = destinationTickets.find((ticket) => ticket.source.ticketId === task.ticket.id);
  const destinationSubtask = destinationTickets.find((ticket) => ticket.source.ticketId === subtask.ticket.id);

  assert.equal(destinationTickets.length, 3);
  assert.equal(transferred.ticket.type, 'story');
  assert.equal(destinationTask.parent, transferred.ticket.id);
  assert.equal(destinationSubtask.parent, destinationTask.id);
  assert.deepEqual((await source.listTickets()), []);
  assert.equal((await source.getTicket(story.ticket.id)).transferredTo.ticketId, transferred.ticket.id);
  assert.equal((await source.getTicket(task.ticket.id)).transferredTo.ticketId, destinationTask.id);
  assert.equal((await source.getTicket(subtask.ticket.id)).transferredTo.ticketId, destinationSubtask.id);
});

test('transferring a parent preserves archived descendants', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Moving story', type: 'story' });
  const task = await source.createTicket({ title: 'Archived task', type: 'task', parent: story.ticket.id });
  await source.archiveTicket(task.ticket.id);

  await transferTicket(source, destination, story.ticket.id, { actor: 'captain-web' });

  const transferredTask = (await destination.listTickets({ includeArchived: true })).find((ticket) => ticket.source.ticketId === task.ticket.id);
  assert.ok(transferredTask.archivedAt);
  assert.equal((await destination.listTickets()).some((ticket) => ticket.id === transferredTask.id), false);
});

test('archiving a parent rejects active descendants', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const story = await board.createTicket({ title: 'Archive parent', type: 'story' });
  await board.createTicket({ title: 'Active descendant', type: 'task', parent: story.ticket.id });

  await assert.rejects(() => board.archiveTicket(story.ticket.id), /descendant .* is active/);
});

test('active tickets cannot be created or reparented beneath archived parents', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const archivedStory = await board.createTicket({ title: 'Archived story', type: 'story' });
  await board.archiveTicket(archivedStory.ticket.id);
  const activeStory = await board.createTicket({ title: 'Active story', type: 'story' });
  const activeTask = await board.createTicket({ title: 'Active task', type: 'task', parent: activeStory.ticket.id });

  await assert.rejects(() => board.createTicket({ title: 'Blocked task', type: 'task', parent: archivedStory.ticket.id }), /archived parent/);
  await assert.rejects(() => board.updateTicket(activeTask.ticket.id, { parent: archivedStory.ticket.id }), /archived parent/);
  const staged = await board.createTicketUnlocked({ title: 'Archived staging task', type: 'task', parent: archivedStory.ticket.id, archivedAt: new Date().toISOString() });
  assert.ok(staged.ticket.archivedAt);
});

test('updates cannot reactivate a child beneath an archived parent', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const story = await board.createTicket({ title: 'Archived parent', type: 'story' });
  const task = await board.createTicket({ title: 'Archived child', type: 'task', parent: story.ticket.id });
  await board.archiveTicket(task.ticket.id);
  await board.archiveTicket(story.ticket.id);

  await assert.rejects(() => board.updateTicket(task.ticket.id, { archivedAt: null }), /archived parent/);
});

test('transfer restores archived ancestors required by active descendants', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Transfer hierarchy', type: 'story' });
  const task = await source.createTicket({ title: 'Archived parent', type: 'task', parent: story.ticket.id });
  const subtask = await source.createTicket({ title: 'Active child', type: 'subtask', parent: task.ticket.id });
  const archivedTask = { ...(await source.getTicket(task.ticket.id)), archivedAt: new Date().toISOString() };
  await source.writeTicket(archivedTask);

  await transferTicket(source, destination, story.ticket.id);

  const moved = await destination.listTickets();
  const movedTask = moved.find((ticket) => ticket.source.ticketId === task.ticket.id);
  const movedSubtask = moved.find((ticket) => ticket.source.ticketId === subtask.ticket.id);
  assert.ok(movedTask);
  assert.equal(movedSubtask.parent, movedTask.id);
});

test('transferring a standalone subtask preserves its type', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Source story', type: 'story' });
  const task = await source.createTicket({ title: 'Source task', type: 'task', parent: story.ticket.id });
  const subtask = await source.createTicket({ title: 'Transfer me', type: 'subtask', parent: task.ticket.id });

  const transferred = await transferTicket(source, destination, subtask.ticket.id, { actor: 'captain-web' });

  assert.equal(transferred.ticket.type, 'subtask');
  assert.equal(transferred.ticket.parent, null);
  assert.equal((await destination.getTicketDetail(transferred.ticket.id)).activity.some((event) => event.action === 'ticket-demoted-on-transfer'), false);
  const edited = await destination.updateTicket(transferred.ticket.id, { title: 'Edited standalone transfer', type: 'subtask', parent: null });
  assert.equal(edited.ticket.title, 'Edited standalone transfer');
});

test('transferring a parent reparents an already transferred child', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Parent later', type: 'story' });
  const task = await source.createTicket({ title: 'Child first', type: 'task', parent: story.ticket.id });
  const movedTask = await transferTicket(source, destination, task.ticket.id);

  const movedStory = await transferTicket(source, destination, story.ticket.id);

  assert.equal((await destination.getTicket(movedTask.ticket.id)).parent, movedStory.ticket.id);
});

test('type changes reject parent links that would invalidate existing children', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const story = await board.createTicket({ title: 'Story', type: 'story' });
  const task = await board.createTicket({ title: 'Task', type: 'task', parent: story.ticket.id });
  const otherTask = await board.createTicket({ title: 'Other task', type: 'task', parent: story.ticket.id });
  const subtask = await board.createTicket({ title: 'Subtask', type: 'subtask', parent: task.ticket.id });

  await assert.rejects(() => board.updateTicket(story.ticket.id, { type: 'task' }), new RegExp(`incompatible children: ${task.ticket.id} \\(task\\)`));
  await assert.rejects(() => board.updateTicket(task.ticket.id, { type: 'subtask', parent: otherTask.ticket.id }), new RegExp(`incompatible children: ${subtask.ticket.id} \\(subtask\\)`));
  const standalone = await board.createTicket({ title: 'Standalone task' });
  await assert.rejects(() => board.updateTicket(standalone.ticket.id, { type: 'subtask', parent: standalone.ticket.id }), /cannot be its own parent/);
});

test('a failed source subtree archival rolls back both boards', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Recover transfer', type: 'story' });
  const task = await source.createTicket({ title: 'Retain source hierarchy', type: 'task', parent: story.ticket.id });
  const archiveTicketUnlocked = source.archiveTicketUnlocked.bind(source);
  source.archiveTicketUnlocked = async (id, options) => {
    if (id === task.ticket.id) throw new Error('Source write failed.');
    return archiveTicketUnlocked(id, options);
  };

  await assert.rejects(() => transferTicket(source, destination, story.ticket.id), /Source write failed/);
  const remaining = await source.listTickets();
  assert.equal(remaining.length, 2);
  assert.equal(remaining.find((ticket) => ticket.id === task.ticket.id).parent, story.ticket.id);
  assert.equal((await destination.listTickets()).length, 0);
});

test('a failed destination subtree staging rolls back created copies', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Stage transfer', type: 'story' });
  const task = await source.createTicket({ title: 'Stage child', type: 'task', parent: story.ticket.id });
  const createTicketUnlocked = destination.createTicketUnlocked.bind(destination);
  destination.createTicketUnlocked = async (changes) => {
    if (changes.title === task.ticket.title) throw new Error('Destination write failed.');
    return createTicketUnlocked(changes);
  };

  await assert.rejects(() => transferTicket(source, destination, story.ticket.id), /Destination write failed/);
  assert.equal((await source.listTickets()).length, 2);
  assert.equal((await destination.listTickets({ includeArchived: true })).length, 0);
});

test('resuming an interrupted subtree transfer restores transferred active tickets', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Resume transfer', type: 'story' });
  const task = await source.createTicket({ title: 'Resume child', type: 'task', parent: story.ticket.id });
  const destinationStory = await destination.createTicket({ title: story.ticket.title, type: 'story', source: { type: 'crewboard-transfer', projectPath: source.root, ticketId: story.ticket.id } });
  const destinationTask = await destination.createTicket({ title: task.ticket.title, type: 'task', parent: destinationStory.ticket.id, source: { type: 'crewboard-transfer', projectPath: source.root, ticketId: task.ticket.id } });
  await destination.archiveTicket(destinationTask.ticket.id);
  await destination.archiveTicket(destinationStory.ticket.id);
  await source.archiveTicketUnlocked(story.ticket.id, { transferredTo: { ticketId: destinationStory.ticket.id, projectPath: destination.root }, allowActiveDescendants: true });

  await transferTicket(source, destination, story.ticket.id);

  const moved = await destination.listTickets();
  assert.equal(moved.length, 2);
  assert.equal(moved.find((ticket) => ticket.id === destinationTask.ticket.id).parent, destinationStory.ticket.id);
  assert.equal((await source.listTickets()).length, 0);
});

test('a failed transfer resume restores both boards to their prior state', async () => {
  const root = await temporaryDirectory();
  const source = await BoardStore.initialize(path.join(root, 'source'), { name: 'Source' });
  const destination = await BoardStore.initialize(path.join(root, 'destination'), { name: 'Destination' });
  const story = await source.createTicket({ title: 'Resume rollback', type: 'story' });
  const task = await source.createTicket({ title: 'Resume rollback child', type: 'task', parent: story.ticket.id });
  const destinationStory = await destination.createTicket({ title: story.ticket.title, type: 'story', source: { type: 'crewboard-transfer', projectPath: source.root, ticketId: story.ticket.id } });
  const destinationTask = await destination.createTicket({ title: task.ticket.title, type: 'task', parent: destinationStory.ticket.id, source: { type: 'crewboard-transfer', projectPath: source.root, ticketId: task.ticket.id } });
  await destination.archiveTicket(destinationTask.ticket.id);
  await destination.archiveTicket(destinationStory.ticket.id);
  await source.archiveTicketUnlocked(story.ticket.id, { transferredTo: { ticketId: destinationStory.ticket.id, projectPath: destination.root }, allowActiveDescendants: true });
  const restoreTicketUnlocked = destination.restoreTicketUnlocked.bind(destination);
  destination.restoreTicketUnlocked = async (id, options) => {
    if (id === destinationTask.ticket.id) throw new Error('Destination restore failed.');
    return restoreTicketUnlocked(id, options);
  };

  await assert.rejects(() => transferTicket(source, destination, story.ticket.id), /Destination restore failed/);
  assert.equal((await source.listTickets()).length, 2);
  assert.equal((await destination.listTickets()).length, 0);
  assert.equal((await destination.listTickets({ includeArchived: true })).length, 2);
});
