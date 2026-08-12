import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { generateTicketId, resolveTicketQuery, slugifyTitle } from '../src/ids.js';
import { buildTree, progressFor } from '../src/hierarchy.js';
import { normalizePriority } from '../src/priority.js';
import { BoardStore } from '../src/store.js';
import { temporaryDirectory } from '../test-support/helpers.js';

test('short ticket ids use a slug and collision-resistant suffix', () => {
  assert.equal(slugifyTitle('Premium Features!'), 'premium-features');
  const ids = new Set();
  const first = generateTicketId('Premium Features', ids);
  ids.add(first);
  const second = generateTicketId('Premium Features', ids);
  assert.match(first, /^premium-features-[a-f0-9]{4}$/);
  assert.match(second, /^premium-features-[a-f0-9]{4}$/);
  assert.notEqual(first, second);
});

test('ticket lookup accepts aliases and unambiguous prefixes', () => {
  const tickets = [
    { id: 'premium-features-x4f2', aliases: ['CB-12345678901234567890'], title: 'Premium' },
    { id: 'premium-trial-a1b2', aliases: [], title: 'Trial' },
    { id: 'role-aware-logins-a1b2', aliases: [], title: 'Logins' },
  ];
  assert.equal(resolveTicketQuery('premium-features-x4f2', tickets).id, 'premium-features-x4f2');
  assert.equal(resolveTicketQuery('CB-12345678901234567890', tickets).id, 'premium-features-x4f2');
  assert.equal(resolveTicketQuery('role-aware', tickets).id, 'role-aware-logins-a1b2');
  assert.throws(() => resolveTicketQuery('premium', tickets), /Ambiguous/);
});

test('hierarchy roll-up counts completed descendant tasks and subtasks', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root, { name: 'Pet Diary' });
  const story = await board.createTicket({ title: 'Complete pet diary app with information collection', type: 'story' });
  const premium = await board.createTicket({ title: 'Premium features', type: 'task', parent: story.ticket.id });
  const logins = await board.createTicket({ title: 'Role-aware logins', type: 'task', parent: story.ticket.id });
  await board.createTicket({ title: 'Digestive Pulse analysis', type: 'subtask', parent: premium.ticket.id, status: 'done' });
  await board.createTicket({ title: 'subscription/trial flow', type: 'subtask', parent: premium.ticket.id });
  await board.createTicket({ title: 'organization login', type: 'subtask', parent: logins.ticket.id });
  await board.createTicket({ title: 'adopter login', type: 'subtask', parent: logins.ticket.id });
  await board.createTicket({ title: 'foster login', type: 'subtask', parent: logins.ticket.id });

  const tickets = await board.listTicketRecords();
  const storyView = await board.getTicketView(story.ticket.id);
  assert.equal(storyView.progress.total, 2);
  assert.equal(storyView.progress.completed, 0);
  const premiumView = await board.getTicketView(premium.ticket.id);
  assert.deepEqual(premiumView.progress, { completed: 1, total: 2, kind: 'subtasks' });
  assert.equal(progressFor(storyView, tickets, board.config.columns).kind, 'tasks');

  const tree = await board.tree();
  assert.equal(tree.roots[0].id, story.ticket.id);
  assert.equal(tree.roots[0].nodes.length, 2);
  assert.equal(tree.roots[0].nodes[0].nodes.length, 2);

  await board.moveTicket((await board.listTickets()).find((ticket) => ticket.title === 'subscription/trial flow').id, 'done');
  const storyDone = await board.getTicketView(story.ticket.id);
  assert.equal(storyDone.progress.completed, 1);
  assert.equal(storyDone.progress.total, 2);
});

test('legacy CB ticket files migrate to short ids while aliases remain resolvable', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const legacyId = 'CB-12345678901234567890';
  const childLegacyId = 'CB-09876543210987654321';
  const ticketsPath = path.join(root, '.crewboard', 'tickets');
  const legacyTicket = (id, title, type, parent, position) => `---
schemaVersion: 1
id: "${id}"
title: "${title}"
type: "${type}"
parent: ${JSON.stringify(parent)}
status: "inbox"
assignee: null
labels: []
priority: "normal"
links: []
source: null
position: ${position}
archivedAt: null
transferredTo: null
statusHistory: []
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---

Body

<!-- crewboard-messages
[]
-->
`;
  await fs.writeFile(path.join(ticketsPath, `${legacyId}.md`), legacyTicket(legacyId, 'Legacy story', 'story', null, 1));
  await fs.writeFile(path.join(ticketsPath, `${childLegacyId}.md`), legacyTicket(childLegacyId, 'Legacy child', 'task', legacyId, 2));
  board._migrated = false;
  board._ready = null;
  await board.ensureBoardReady();
  const files = await fs.readdir(path.join(root, '.crewboard', 'tickets'));
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => !file.startsWith('CB-')));
  const migrated = await board.getTicket(legacyId);
  const child = await board.getTicket(childLegacyId);
  assert.match(migrated.id, /^legacy-story-[a-f0-9]{4}$/);
  assert.ok(migrated.aliases.includes(legacyId));
  assert.equal(child.parent, migrated.id);
});

test('ticket detail exposes reporter, activity, breadcrumb, and child table progress', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root, { name: 'Pet Diary' });
  const story = await board.createTicket({ title: 'Complete pet diary app', type: 'story', actor: 'firstmate', priority: 'high' });
  const task = await board.createTicket({ title: 'Premium features', type: 'task', parent: story.ticket.id, actor: 'firstmate', assignee: 'builder', priority: 'p1' });
  await board.createTicket({ title: 'Digestive Pulse analysis', type: 'subtask', parent: task.ticket.id, status: 'done', actor: 'builder' });
  await board.moveTicket(task.ticket.id, 'active', { actor: 'builder', note: 'Started' });

  const detail = await board.getTicketDetail(task.ticket.id);
  assert.equal(detail.ticket.reporter, 'firstmate');
  assert.equal(detail.ticket.priority, 'high');
  assert.equal(detail.ticket.assignedBy, 'firstmate');
  assert.equal(detail.breadcrumb[0].kind, 'project');
  assert.equal(detail.ticket.childTickets.length, 1);
  assert.equal(detail.ticket.progress.completed, 1);
  assert.ok(detail.activity.some((entry) => entry.action === 'ticket-moved'));
});

test('priority aliases map onto the Jira-style scale', async () => {
  assert.equal(normalizePriority('normal'), 'medium');
  assert.equal(normalizePriority('p0'), 'highest');
  assert.throws(() => normalizePriority('nope'), /Unknown priority/);
});

test('firstmate is registered as the board leader', async () => {
  const root = await temporaryDirectory();
  const board = await BoardStore.initialize(root);
  const agents = await board.agents();
  const leader = agents.agents.find((agent) => agent.name === 'firstmate');
  assert.equal(leader.role, 'leader');
  assert.match(leader.description, /leads the fleet/);
  const { ticket } = await board.createTicket({ title: 'Assigned work', assignee: 'worker', actor: 'firstmate' });
  assert.equal(ticket.assignedBy, 'firstmate');
  const assigned = await board.assignTicket(ticket.id, 'scout', { actor: 'firstmate' });
  assert.equal(assigned.ticket.assignee, 'scout');
  assert.equal(assigned.ticket.assignedBy, 'firstmate');
});

test('buildTree nests story task subtask relationships', () => {
  const tickets = [
    { id: 'story-aaaa', type: 'story', parent: null, title: 'Story', status: 'inbox', position: 1 },
    { id: 'task-bbbb', type: 'task', parent: 'story-aaaa', title: 'Task', status: 'active', position: 1 },
    { id: 'sub-cccc', type: 'subtask', parent: 'task-bbbb', title: 'Sub', status: 'done', position: 1 },
  ];
  const tree = buildTree(tickets, ['inbox', 'active', 'done']);
  assert.equal(tree.roots[0].nodes[0].nodes[0].id, 'sub-cccc');
  assert.equal(tree.roots[0].progress.completed, 1);
  assert.equal(tree.roots[0].progress.total, 1);
});
