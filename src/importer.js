import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { cleanList } from './utils.js';

function metadata(line) {
  const values = {};
  for (const match of line.matchAll(/\s+\(([^:()]+):\s*([^)]*)\)/g)) {
    values[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return values;
}

function titleAndKey(raw, lineNumber) {
  const withoutMetadata = raw.replace(/\s+\([^:()]+:\s*[^)]*\)/g, '').trim();
  const match = withoutMetadata.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s+-\s+(.+)$/);
  if (match) return { title: match[2].trim(), key: `id:${match[1]}` };
  return { title: withoutMetadata, key: `line:${lineNumber}:${crypto.createHash('sha256').update(withoutMetadata).digest('hex').slice(0, 12)}` };
}

export function parseTasksAxi(markdown) {
  const imported = [];
  for (const [index, line] of markdown.split('\n').entries()) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const details = metadata(match[2]);
    const { title, key } = titleAndKey(match[2], index + 1);
    if (!title) continue;
    imported.push({
      key,
      title,
      complete: match[1].toLowerCase() === 'x',
      state: details.state || null,
      assignee: details.assignee || details.owner || null,
      labels: cleanList([details.label || '', details.labels || '', details.kind || '']),
      priority: details.priority || 'medium',
      links: cleanList([details.pr || '', details.link || '', details.file || '']),
    });
  }
  return imported;
}

function mappedStatus(board, task) {
  if (task.complete) return board.config.columns.includes('done') ? 'done' : board.config.columns.at(-1);
  if (task.state && board.config.columns.includes(task.state)) return task.state;
  if (task.state === 'working' && board.config.columns.includes('active')) return 'active';
  if (task.state === 'queued' && board.config.columns.includes('ready')) return 'ready';
  return board.config.columns[0];
}

export async function importTasksAxi(board, sourcePath, { actor = 'tasks-axi' } = {}) {
  const tasks = parseTasksAxi(await fs.readFile(sourcePath, 'utf8'));
  return board.withMutationLock(async () => {
    await board.refreshConfig();
    const tickets = await board.listTickets();
    const bySourceKey = new Map(tickets.filter((ticket) => ticket.source?.type === 'tasks-axi').map((ticket) => [ticket.source.key, ticket]));
    const result = { sourcePath, imported: [], updated: [], unchanged: [], skipped: [] };

    for (const task of tasks) {
      const status = mappedStatus(board, task);
      const source = { type: 'tasks-axi', key: task.key };
      const existing = bySourceKey.get(task.key);
      if (!existing) {
        const created = await board.createTicketUnlocked({
          title: task.title,
          body: 'Imported from tasks-axi.',
          status,
          assignee: task.assignee,
          labels: task.labels,
          priority: task.priority,
          links: task.links,
          source,
          actor,
        });
        bySourceKey.set(task.key, created.ticket);
        result.imported.push(created.ticket);
        continue;
      }
      const changes = { title: task.title, status, assignee: task.assignee, labels: task.labels, priority: task.priority, links: task.links };
      const changed = Object.entries(changes).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value));
      if (!changed) {
        result.unchanged.push(existing);
        continue;
      }
      const updated = await board.updateTicketUnlocked(existing.id, changes, {
        action: 'tasks-axi-synced',
        actor,
        eventData: { sourceKey: task.key },
      });
      bySourceKey.set(task.key, updated.ticket);
      result.updated.push(updated.ticket);
    }
    return result;
  });
}
