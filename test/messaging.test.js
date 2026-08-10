import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardStore } from '../src/store.js';
import { postMessage } from '../src/lifecycle.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('mentions and assignments provide a cursor-based agent inbox', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const { ticket } = await board.createTicket({ title: 'Coordinate deployment' });
  await board.assignTicket(ticket.id, 'captain', { actor: 'triage' });
  const first = await postMessage(root, ticket.id, { author: 'builder', body: 'The preview is ready for @captain.' });
  const firstCheckpoint = (await board.activity()).cursor;
  const second = await postMessage(root, ticket.id, {
    author: 'captain',
    body: 'Thanks. @builder please add the release note.',
    replyTo: first.message.id,
  });

  const captainInbox = await board.inbox('captain', 0);
  assert.equal(captainInbox.assignments.length, 1);
  assert.equal(captainInbox.messages.length, 1);
  assert.equal(captainInbox.messages[0].data.message.id, first.message.id);

  const builderInbox = await board.inbox('builder', firstCheckpoint);
  assert.equal(builderInbox.messages.length, 1);
  assert.equal(builderInbox.messages[0].data.message.replyTo, first.message.id);
  assert.match(builderInbox.cursor, /^v1\./);
});

test('messages reject reply targets that are not on the ticket', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const { ticket } = await board.createTicket({ title: 'Preserve message threads' });

  await assert.rejects(
    () => board.addComment(ticket.id, { author: 'builder', body: 'Acknowledged.', replyTo: 'm-missing' }),
    /Reply target not found: m-missing/,
  );
  assert.equal((await board.getTicket(ticket.id)).messages.length, 0);
});
