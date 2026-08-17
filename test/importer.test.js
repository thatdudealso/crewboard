import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { importTasksAxi, parseTasksAxi } from '../src/importer.js';
import { BoardStore } from '../src/store.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('tasks-axi markdown is imported and syncs idempotently', async () => {
  const root = await temporaryDirectory();
  const source = path.join(root, 'backlog.md');
  await fs.writeFile(source, [
    '# Fleet backlog',
    '- [ ] crewboard-build - Build the board (state: working) (kind: ship) (assignee: builder) (priority: high)',
    '- [x] crewboard-docs - Write the docs (kind: docs) (pr: https://example.test/pull/2)',
  ].join('\n'));
  const parsed = parseTasksAxi(await fs.readFile(source, 'utf8'));
  assert.equal(parsed[0].key, 'id:crewboard-build');
  assert.equal(parsed[0].title, 'Build the board');
  assert.deepEqual(parsed[0].labels, ['ship']);

  const board = await BoardStore.initialize(root);
  const first = await importTasksAxi(board, source);
  assert.equal(first.imported.length, 2);
  assert.equal((await board.getTicket(first.imported[0].id)).status, 'active');
  assert.equal((await board.getTicket(first.imported[1].id)).status, 'done');

  const second = await importTasksAxi(board, source);
  assert.equal(second.imported.length, 0);
  assert.equal(second.unchanged.length, 2);

  await fs.writeFile(source, '- [x] crewboard-build - Build the board (kind: ship)\n');
  const third = await importTasksAxi(board, source);
  assert.equal(third.updated.length, 1);
  assert.equal((await board.getTicket(first.imported[0].id)).status, 'done');
});

test('imported tasks-axi tickets receive short ids and stay idempotent', async () => {
  const root = await temporaryDirectory();
  const source = path.join(root, 'backlog.md');
  await fs.writeFile(source, '- [ ] crewboard-build - Build the board (kind: ship)\n');
  const board = await BoardStore.initialize(root);
  const first = await importTasksAxi(board, source);
  assert.match(first.imported[0].id, /^build-the-board-[a-f0-9]{4}$/);
  const second = await importTasksAxi(board, source);
  assert.equal(second.unchanged[0].id, first.imported[0].id);
});

test('re-import restores an archived source-key ticket without duplicating it', async () => {
  const root = await temporaryDirectory();
  const source = path.join(root, 'backlog.md');
  await fs.writeFile(source, '- [x] crewboard-build - Build the board (kind: ship)\n');
  const board = await BoardStore.initialize(root);
  const first = await importTasksAxi(board, source);
  await board.archiveTicket(first.imported[0].id);

  const repeated = await importTasksAxi(board, source);
  const tickets = await board.listTickets({ includeArchived: true });

  assert.equal(repeated.imported.length, 0);
  assert.equal(repeated.updated.length, 1);
  assert.equal(repeated.updated[0].id, first.imported[0].id);
  assert.equal(repeated.updated[0].archivedAt, null);
  assert.equal(tickets.filter((ticket) => ticket.source?.key === 'id:crewboard-build').length, 1);
});

test('unknown import priorities fall back to medium and report each normalization', async () => {
  const root = await temporaryDirectory();
  const source = path.join(root, 'backlog.md');
  await fs.writeFile(source, '- [ ] crewboard-build - Build the board (priority: blocker)\n');
  const board = await BoardStore.initialize(root);

  const result = await importTasksAxi(board, source);

  assert.equal(result.imported[0].priority, 'medium');
  assert.deepEqual(result.normalizations, [{
    ticketId: result.imported[0].id,
    sourceKey: 'id:crewboard-build',
    field: 'priority',
    from: 'blocker',
    to: 'medium',
  }]);
});

test('simultaneous imports create each source task once', async () => {
  const root = await temporaryDirectory();
  const source = path.join(root, 'backlog.md');
  await fs.writeFile(source, '- [ ] crewboard-build - Build the board\n');
  const first = await BoardStore.initialize(root);
  const second = await BoardStore.open(root);

  await Promise.all([importTasksAxi(first, source), importTasksAxi(second, source)]);

  assert.equal((await first.listTickets()).filter((ticket) => ticket.source?.key === 'id:crewboard-build').length, 1);
});
