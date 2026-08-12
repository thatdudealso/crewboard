import path from 'node:path';
import process from 'node:process';
import { BoardStore } from './store.js';
import { assignTicket, createTicket, moveTicket, postMessage } from './lifecycle.js';
import { importTasksAxi } from './importer.js';
import { findBoardRoot, normalizeBoardRoot, summarize } from './utils.js';
import {
  addBoardToWorkspace,
  approveWorkspaceProject,
  arrangeWorkspaceProject,
  createWorkspaceProject,
  discoverProjects,
  initializeWorkspace,
  listWorkspace,
  renameWorkspaceProject,
  updateWorkspaceProject,
} from './workspace.js';
import { assembleGithubAttention } from './github-attention.js';
import { startWebServer } from './web.js';

export const usage = `crewboard - a git-native coordination board for agent fleets

Usage:
  crewboard init [--name <name>] [--statuses inbox,ready,active,review,done]
  crewboard create <title> [--body <text>] [--status <column>] [--assignee <name>] [--label <label>] [--priority <value>] [--link <url-or-path>] [--as <agent>]
  crewboard list [--status <column>] [--assignee <name>]
  crewboard show <ticket-id>
  crewboard move <ticket-id> <status> [--as <agent>] [--note <text>]
  crewboard assign <ticket-id> <agent> [--as <agent>]
  crewboard comment <ticket-id> <message> --as <agent> [--mention <agent>] [--reply-to <message-id>]
  crewboard inbox --as <agent> [--since <cursor>]
  crewboard activity [--since <cursor>]
  crewboard import tasks-axi <backlog.md> [--as <agent>]
  crewboard web [--workspace <workspace.json>] [--port <port>]
  crewboard github attention [--all] [--workspace <workspace.json>]
  crewboard workspace init [--file <workspace.json>]
  crewboard workspace add <board-path> [--file <workspace.json>]
  crewboard workspace create <name> --path <board-path> [--organization <name>]
  crewboard workspace discover <local|claude|chatgpt> [--root <path>]
  crewboard workspace approve <project-id> [--path <board-path>]
  crewboard workspace rename <project-id> <name>
  crewboard workspace archive|restore <project-id>
  crewboard workspace organize <project-id> <organization>
  crewboard workspace arrange <project-id> <up|down>
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
    if (key === 'json' || key === 'help' || key === 'all') {
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

  if (command === 'web') {
    const port = options.port === undefined ? undefined : Number(options.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Web port must be an integer from 0 to 65535.');
    const result = await startWebServer({ cwd, workspaceFile: options.workspace || 'crewboard-workspace.json', port });
    return render({ url: result.url, workspaceFile: result.workspaceFile }, { json, human: (value) => `Crewboard web is listening at ${value.url}\nWorkspace: ${value.workspaceFile}` });
  }

  if (command === 'github') {
    const [githubCommand] = arguments_;
    if (githubCommand !== 'attention') throw new Error('Usage: crewboard github attention [--all] [--workspace <workspace.json>].');
    const result = await assembleGithubAttention({
      cwd,
      workspaceFile: options.workspace || options.file || 'crewboard-workspace.json',
      all: Boolean(options.all),
    });
    return render(result, {
      json,
      human: (value) => {
        if (!value.available) return `GitHub attention unavailable: ${value.error}`;
        if (!value.items.length) {
          return value.notice
            || (value.mode === 'all' ? 'No open GitHub items for the configured repositories.' : 'Nothing on GitHub needs the captain right now.');
        }
        return value.items.map((item) => {
          const flags = [
            item.kind.toUpperCase(),
            item.draft ? 'draft' : null,
            item.reviewState !== 'none' ? `review:${item.reviewState}` : null,
            item.mergeableState !== 'unknown' ? `merge:${item.mergeableState}` : null,
            item.ciStatus !== 'unknown' ? `ci:${item.ciStatus}` : null,
            item.reasons.length ? `why:${item.reasons.join(',')}` : null,
          ].filter(Boolean).join(' · ');
          return `${item.repo}#${item.number}  ${item.title}\n  ${flags}\n  ${item.url}`;
        }).join('\n');
      },
    });
  }

  if (command === 'workspace') {
    const [workspaceCommand, firstArgument, secondArgument] = arguments_;
    const filePath = workspacePath(options, cwd);
    if (workspaceCommand === 'init') {
      const result = await initializeWorkspace(filePath);
      return render(result, { json, human: (value) => `Initialized workspace at ${value.filePath}` });
    }
    if (workspaceCommand === 'add') {
      if (!firstArgument) throw new Error('Usage: crewboard workspace add <board-path>.');
      const result = await addBoardToWorkspace(filePath, path.resolve(cwd, firstArgument));
      return render(result, { json, human: (value) => value.unchanged ? `${value.project.name} is already registered.` : `Registered ${value.project.name}.` });
    }
    if (workspaceCommand === 'create') {
      if (!firstArgument || !options.path) throw new Error('Usage: crewboard workspace create <name> --path <board-path>.');
      const result = await createWorkspaceProject(filePath, { name: firstArgument, boardPath: path.resolve(cwd, options.path), organization: options.organization });
      return render(result, { json, human: (value) => `Created project ${value.project.name}.` });
    }
    if (workspaceCommand === 'discover') {
      if (!firstArgument) throw new Error('Usage: crewboard workspace discover <local|claude|chatgpt> [--root <path>].');
      const result = await discoverProjects(filePath, { source: firstArgument, root: options.root || undefined });
      return render(result, { json, human: (value) => value.sourceFound ? `Found ${value.discovered.length} project candidate(s) awaiting approval.` : `No ${value.source} source found.` });
    }
    if (workspaceCommand === 'approve') {
      if (!firstArgument) throw new Error('Usage: crewboard workspace approve <project-id> [--path <board-path>].');
      const result = await approveWorkspaceProject(filePath, firstArgument, { boardPath: options.path || null });
      return render(result, { json, human: (value) => `Approved ${value.project.name}.` });
    }
    if (workspaceCommand === 'rename') {
      if (!firstArgument || !secondArgument) throw new Error('Usage: crewboard workspace rename <project-id> <name>.');
      const result = await renameWorkspaceProject(filePath, firstArgument, secondArgument);
      return render(result, { json, human: (value) => `Renamed project to ${value.project.name}.` });
    }
    if (workspaceCommand === 'archive' || workspaceCommand === 'restore') {
      if (!firstArgument) throw new Error(`Usage: crewboard workspace ${workspaceCommand} <project-id>.`);
      const result = await updateWorkspaceProject(filePath, firstArgument, { state: workspaceCommand === 'archive' ? 'archived' : 'active' });
      return render(result, { json, human: (value) => `${workspaceCommand === 'archive' ? 'Archived' : 'Restored'} ${value.project.name}.` });
    }
    if (workspaceCommand === 'organize') {
      if (!firstArgument || !secondArgument) throw new Error('Usage: crewboard workspace organize <project-id> <organization>.');
      const result = await updateWorkspaceProject(filePath, firstArgument, { organization: secondArgument });
      return render(result, { json, human: (value) => `Organized ${value.project.name} in ${value.project.organization}.` });
    }
    if (workspaceCommand === 'arrange') {
      if (!firstArgument || !secondArgument) throw new Error('Usage: crewboard workspace arrange <project-id> <up|down>.');
      const result = await arrangeWorkspaceProject(filePath, firstArgument, secondArgument);
      return render(result, { json, human: (value) => value.unchanged ? `${value.project.name} is already at that edge.` : `Arranged ${value.project.name}.` });
    }
    if (workspaceCommand === 'list') {
      const result = await listWorkspace(filePath);
      return render(result, { json, human: (value) => value.projects.length ? value.projects.map((project) => `${project.name}  ${project.tickets.length} ticket(s)  ${project.path}`).join('\n') : 'Workspace has no boards.' });
    }
    throw new Error('Usage: crewboard workspace <init|add|create|discover|approve|rename|archive|restore|organize|arrange|list>.');
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
    return render({ board: { name: board.config.name, columns: board.config.columns }, tickets, cursor: (await board.activity()).cursor }, { json, human: (value) => value.tickets.length ? value.tickets.map(humanTicket).join('\n') : 'No tickets.' });
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
