import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardStore } from '../src/store.js';
import { assignTicket, createTicket, moveTicket } from '../src/lifecycle.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('ticket lifecycle captures creation, assignment, and movement', async () => {
  const root = await temporaryDirectory();
  await BoardStore.initialize(root);
  const created = await createTicket(root, { title: 'Review agent proposal', actor: 'triage' });
  const assigned = await assignTicket(root, created.ticket.id, 'reviewer', { actor: 'triage' });
  const moved = await moveTicket(root, created.ticket.id, 'review', { actor: 'reviewer', note: 'Ready for feedback' });

  assert.equal(assigned.ticket.assignee, 'reviewer');
  assert.equal(moved.ticket.status, 'review');
  const board = await BoardStore.open(root);
  assert.deepEqual((await board.activity()).events.map((event) => event.action), [
    'ticket-created',
    'ticket-assigned',
    'ticket-moved',
  ]);
});
