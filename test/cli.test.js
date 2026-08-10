import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { temporaryDirectory } from '../test-support/helpers.js';

const binary = path.resolve('bin/crewboard.js');

function command(cwd, ...arguments_) {
  const result = spawnSync(process.execPath, [binary, ...arguments_, '--json'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the CLI completes the agent workflow from init through import and activity polling', async () => {
  const root = await temporaryDirectory();
  command(root, 'init', '--name', 'Fleet work');
  const ticket = command(root, 'create', 'Coordinate', 'release', '--assignee', 'builder').ticket;
  command(root, 'move', ticket.id, 'active', '--as', 'builder');
  command(root, 'comment', ticket.id, 'Please', 'review', '@captain', '--as', 'builder');
  const inbox = command(root, 'inbox', '--as', 'captain', '--since', '0');
  assert.equal(inbox.messages.length, 1);

  const backlog = path.join(root, 'backlog.md');
  await fs.writeFile(backlog, '- [ ] imported-task - Import this work (kind: ship)\n');
  const imported = command(root, 'import', 'tasks-axi', 'backlog.md', '--as', 'keeper');
  assert.equal(imported.imported.length, 1);
  const activity = command(root, 'activity', '--since', String(inbox.cursor));
  assert.equal(activity.events.at(-1).action, 'ticket-created');
});

test('help produces machine-readable output when requested', async () => {
  const root = await temporaryDirectory();
  const help = command(root, 'help');

  assert.match(help.usage, /^crewboard - a git-native coordination board/);
});
