import path from 'node:path';
import process from 'node:process';
import { BoardStore } from './store.js';
import { assignTicket, createTicket, moveTicket, postMessage } from './lifecycle.js';
import { importTasksAxi } from './importer.js';
import { findBoardRoot, normalizeBoardRoot, summarize } from './utils.js';
import { addBoardToWorkspace, initializeWorkspace, listWorkspace } from './workspace.js';

export const usage = `crewboard - a git-native coordination board for agent fleets

Usage:
  crewboard init [--name <name>] [--statuses inbox,ready,active,review,done]
  crewboard create <title> [--body <text>] [--status <column>] [--assignee <name>]
  crewboard list [--status <column>] [--assignee <name>]
  crewboard show <ticket-id>
  crewboard move <ticket-id> <status> [--as <agent>] [--note <text>]
  crewboard assign <ticket-id> <agent> [--as <agent>]
  crewboard comment <ticket-id> <message> --as <agent> [--mention <agent>] [--reply-to <message-id>]
  crewboard inbox --as <agent> [--since <cursor>]
  crewboard activity [--since <cursor>]
  crewboard import tasks-axi <backlog.md> [--as <agent>]
  crewboard workspace init [--file <workspace.json>]
  crewboard workspace add <board-path> [--file <workspace.json>]
  crewboard workspace list [--file <workspace.json>]

All commands accept --json. Board commands also accept --board <project-path>.`;

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === 'json' || key === 'help') {
      options[key] = true;
      continue;
    }
    const optionValue = argv[index + 1];
    if (!optionValue || optionValue.startsWith('--')) throw new Error(`Option --${key} needs a value.`);
    index += 1;
    if (options[key] === undefined) options[key] = optionValue;
    else options[key] = Array.isArray(options[key]) ? [...options[key], optionValue] : [options[key], optionValue];
  }
  return { positionals, options };
}

function optionList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function humanTicket(ticket) {
  const owner = ticket.assignee ? ` · @${ticket.assignee}` : '';
  return `${ticket.id}  ${ticket.status.padEnd(7)} ${ticket.title}${owner}`;
}

function humanActivity(event) {
  const subject = event.ticketId ?? 'board';
  if (event.action === 'message-posted') return `${event.cursor}  ${subject}  @${event.actor}: ${summarize(event.data.message.body)}`;
  if (event.action === 'ticket-moved') return `${event.cursor}  ${subject}  moved ${event.data.from} -> ${event.data.to}`;
  if (event.action === 'ticket-created') return `${event.cursor}  ${subject}  created: ${event.data.title}`;
  return `${event.cursor}  ${subject}  ${event.action}`;
}

function render(value, { json, human }) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`);
}

async function resolveBoard(options, cwd) {
  return options.board ? normalizeBoardRoot(options.board, cwd) : findBoardRoot(cwd);
}

function workspacePath(options, cwd) {
  return path.resolve(cwd, options.file || 'crewboard-workspace.json');
}

export async function run(argv, { cwd = process.cwd() } = {}) {
  const { positionals, options } = parseArguments(argv);
  const [command, ...arguments_] = positionals;
  if (!command || options.help || command === 'help' || command === '--help') {
    return render({ usage }, { json: Boolean(options.json), human: () => usage });
  }
  const json = Boolean(options.json);

  if (command === 'init') {
    const board = await BoardStore.initialize(cwd, { name: options.name, columns: options.statuses?.split(',') });
    return render({ board: board.config, path: board.root }, { json, human: (result) => `Initialized ${result.board.name} at ${result.path}` });
  }

  if (command === 'workspace') {
    const [workspaceCommand, boardPath] = arguments_;
    const filePath = workspacePath(options, cwd);
    if (workspaceCommand === 'init') {
      const result = await initializeWorkspace(filePath);
      return render(result, { json, human: (value) => `Initialized workspace at ${value.filePath}` });
    }
    if (workspaceCommand === 'add') {
      if (!boardPath) throw new Error('Usage: crewboard workspace add <board-path>.');
      const result = await addBoardToWorkspace(filePath, path.resolve(cwd, boardPath));
      return render(result, { json, human: (value) => value.unchanged ? `${value.project.name} is already registered.` : `Registered ${value.project.name}.` });
    }
    if (workspaceCommand === 'list') {
      const result = await listWorkspace(filePath);
      return render(result, { json, human: (value) => value.projects.length ? value.projects.map((project) => `${project.name}  ${project.tickets.length} ticket(s)  ${project.path}`).join('\n') : 'Workspace has no boards.' });
    }
    throw new Error('Usage: crewboard workspace <init|add|list>.');
  }

  const root = await resolveBoard(options, cwd);
  if (command === 'create') {
    const title = arguments_.join(' ');
    const result = await createTicket(root, {
      title,
      body: options.body || '',
      status: options.status,
      assignee: options.assignee,
      labels: optionList(options.label),
      priority: options.priority,
      links: optionList(options.link),
      actor: options.as || null,
    });
    return render(result, { json, human: (value) => `Created ${humanTicket(value.ticket)}` });
  }
  if (command === 'list') {
    const board = await BoardStore.open(root);
    const tickets = await board.listTickets({ status: options.status, assignee: options.assignee });
    return render({ board: { name: board.config.name, columns: board.config.columns }, tickets, cursor: board.config.lastEventCursor }, { json, human: (value) => value.tickets.length ? value.tickets.map(humanTicket).join('\n') : 'No tickets.' });
  }
  if (command === 'show') {
    const [id] = arguments_;
    if (!id) throw new Error('Usage: crewboard show <ticket-id>.');
    const board = await BoardStore.open(root);
    const ticket = await board.getTicket(id);
    return render({ ticket }, { json, human: (value) => {
      const messages = value.ticket.messages.length ? `\n\nMessages\n${value.ticket.messages.map((message) => `- ${message.createdAt} @${message.author}: ${message.body}`).join('\n')}` : '';
      return `${humanTicket(value.ticket)}\n\n${value.ticket.body || '(no description)'}${messages}`;
    } });
  }
  if (command === 'move') {
    const [id, status] = arguments_;
    if (!id || !status) throw new Error('Usage: crewboard move <ticket-id> <status>.');
    const result = await moveTicket(root, id, status, { actor: options.as || null, note: options.note || null });
    return render(result, { json, human: (value) => value.unchanged ? `${value.ticket.id} is already in ${value.ticket.status}.` : `Moved ${value.ticket.id} to ${value.ticket.status}.` });
  }
  if (command === 'assign') {
    const [id, assignee] = arguments_;
    if (!id || !assignee) throw new Error('Usage: crewboard assign <ticket-id> <agent>.');
    const result = await assignTicket(root, id, assignee, { actor: options.as || null });
    return render(result, { json, human: (value) => `Assigned ${value.ticket.id} to @${value.ticket.assignee}.` });
  }
  if (command === 'comment') {
    const [id, ...messageParts] = arguments_;
    if (!id || messageParts.length === 0) throw new Error('Usage: crewboard comment <ticket-id> <message> --as <agent>.');
    const result = await postMessage(root, id, { author: options.as, body: messageParts.join(' '), mentions: optionList(options.mention), replyTo: options['reply-to'] });
    return render(result, { json, human: (value) => `Posted ${value.message.id} to ${value.ticket.id} as @${value.message.author}.` });
  }
  if (command === 'inbox') {
    const board = await BoardStore.open(root);
    const result = await board.inbox(options.as, options.since);
    return render(result, { json, human: (value) => {
      const entries = [...value.messages, ...value.assignments].sort((left, right) => left.cursor - right.cursor);
      return entries.length ? `Inbox @${value.agent} through ${value.cursor}\n${entries.map(humanActivity).join('\n')}` : `Inbox @${value.agent} is clear through ${value.cursor}.`;
    } });
  }
  if (command === 'activity') {
    const board = await BoardStore.open(root);
    const result = await board.activity(options.since);
    return render(result, { json, human: (value) => value.events.length ? `Activity through ${value.cursor}\n${value.events.map(humanActivity).join('\n')}` : `No activity through ${value.cursor}.` });
  }
  if (command === 'import') {
    const [kind, sourcePath] = arguments_;
    if (kind !== 'tasks-axi' || !sourcePath) throw new Error('Usage: crewboard import tasks-axi <backlog.md>.');
    const board = await BoardStore.open(root);
    const result = await importTasksAxi(board, path.resolve(cwd, sourcePath), { actor: options.as || 'tasks-axi' });
    return render(result, { json, human: (value) => `tasks-axi sync: ${value.imported.length} imported, ${value.updated.length} updated, ${value.unchanged.length} unchanged.` });
  }
  throw new Error(`Unknown command: ${command}. Run \`crewboard help\`.`);
}
