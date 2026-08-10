import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { withFileLock } from './lock.js';
import { DEFAULT_COLUMNS, cleanList, eventCursor, mentionsIn, now, pathExists } from './utils.js';

const BOARD_DIRECTORY = '.crewboard';

function frontmatter(ticket) {
  const fields = {
    schemaVersion: 1,
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    assignee: ticket.assignee ?? null,
    labels: ticket.labels ?? [],
    priority: ticket.priority ?? 'normal',
    links: ticket.links ?? [],
    source: ticket.source ?? null,
    position: ticket.position ?? 0,
    archivedAt: ticket.archivedAt ?? null,
    transferredTo: ticket.transferredTo ?? null,
    statusHistory: ticket.statusHistory ?? [],
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---`;
}

function serializeTicket(ticket) {
  const body = ticket.body?.trim() ?? '';
  const messages = JSON.stringify(ticket.messages ?? [], null, 2);
  return `${frontmatter(ticket)}\n\n${body}\n\n<!-- crewboard-messages\n${messages}\n-->\n`;
}

function parseTicket(contents, filePath) {
  const header = contents.match(/^---\n([\s\S]*?)\n---\n\n?/);
  const footer = '\n<!-- crewboard-messages\n';
  const footerIndex = contents.lastIndexOf(footer);
  const footerEnd = '\n-->\n';
  if (!header || footerIndex < header[0].length || !contents.endsWith(footerEnd)) throw new Error(`Invalid Crewboard ticket file: ${filePath}`);
  const values = {};
  for (const line of header[1].split('\n')) {
    const separator = line.indexOf(': ');
    if (separator < 1) throw new Error(`Invalid frontmatter in ${filePath}`);
    const key = line.slice(0, separator);
    values[key] = JSON.parse(line.slice(separator + 2));
  }
  const messageStart = footerIndex + footer.length;
  const messageEnd = contents.length - footerEnd.length;
  return { ...values, body: contents.slice(header[0].length, footerIndex).trim(), messages: JSON.parse(contents.slice(messageStart, messageEnd)) };
}

function ticketFileName(ticketId) {
  if (!/^CB-\d{4,}$/.test(ticketId)) throw new Error(`Invalid ticket id: ${ticketId}`);
  return `${ticketId}.md`;
}

export class BoardStore {
  static async initialize(root, { name = path.basename(root), columns = DEFAULT_COLUMNS } = {}) {
    const absoluteRoot = path.resolve(root);
    const boardPath = path.join(absoluteRoot, BOARD_DIRECTORY);
    await fs.mkdir(absoluteRoot, { recursive: true });
    return withFileLock(path.join(absoluteRoot, '.crewboard.init.lock'), 'Crewboard is busy with initialization. Retry the command.', async () => {
      if (await pathExists(boardPath)) throw new Error(`Crewboard already exists at ${boardPath}`);
      const cleanColumns = cleanList(columns);
      if (cleanColumns.length < 2) throw new Error('A board needs at least two status columns.');
      const timestamp = now();
      const config = {
        schemaVersion: 1,
        name,
        columns: cleanColumns,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextTicketNumber: 1,
        lastEventCursor: 0,
      };
      const stagingPath = path.join(absoluteRoot, `.crewboard.initializing-${crypto.randomUUID()}`);
      await fs.mkdir(path.join(stagingPath, 'tickets'), { recursive: true });
      try {
        await atomicWriteFile(path.join(stagingPath, 'board.json'), `${JSON.stringify(config, null, 2)}\n`);
        await fs.writeFile(path.join(stagingPath, 'events.jsonl'), '');
        await fs.rename(stagingPath, boardPath);
      } catch (error) {
        await fs.rm(stagingPath, { recursive: true, force: true });
        throw error;
      }
      return new BoardStore(absoluteRoot, config);
    });
  }

  static async open(root) {
    const configPath = path.join(root, BOARD_DIRECTORY, 'board.json');
    let config;
    try {
      config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`No Crewboard found at ${root}. Run \`crewboard init\`.`);
      throw error;
    }
    return new BoardStore(root, config);
  }

  constructor(root, config) {
    this.root = path.resolve(root);
    this.path = path.join(this.root, BOARD_DIRECTORY);
    this.config = config;
  }

  get ticketsPath() {
    return path.join(this.path, 'tickets');
  }

  async withMutationLock(operation) {
    const lockPath = path.join(this.path, '.mutation.lock');
    return withFileLock(lockPath, 'Crewboard is busy with another mutation. Retry the command.', operation);
  }

  async saveConfig() {
    this.config.updatedAt = now();
    await atomicWriteFile(path.join(this.path, 'board.json'), `${JSON.stringify(this.config, null, 2)}\n`);
  }

  async refreshConfig() {
    this.config = JSON.parse(await fs.readFile(path.join(this.path, 'board.json'), 'utf8'));
  }

  assertStatus(status) {
    if (!this.config.columns.includes(status)) {
      throw new Error(`Unknown status "${status}". Valid statuses: ${this.config.columns.join(', ')}.`);
    }
  }

  async writeTicket(ticket) {
    await atomicWriteFile(path.join(this.ticketsPath, ticketFileName(ticket.id)), serializeTicket(ticket));
  }

  async getTicket(id) {
    const filePath = path.join(this.ticketsPath, ticketFileName(id));
    try {
      return parseTicket(await fs.readFile(filePath, 'utf8'), filePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Ticket not found: ${id}`);
      throw error;
    }
  }

  async listTickets({ status, assignee, includeArchived = false } = {}) {
    let files;
    try {
      files = await fs.readdir(this.ticketsPath);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const tickets = await Promise.all(files.filter((file) => file.endsWith('.md')).sort().map((file) => this.getTicket(file.slice(0, -3))));
    return tickets
      .filter((ticket) => (includeArchived || !ticket.archivedAt) && (!status || ticket.status === status) && (!assignee || ticket.assignee === assignee))
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
  }

  async appendEvent(action, { ticketId = null, actor = null, data = {} } = {}) {
    await this.refreshConfig();
    await this.repairEventLog();
    const events = await this.readEvents();
    const lastEventCursor = events.at(-1)?.cursor ?? 0;
    const event = {
      cursor: lastEventCursor + 1,
      at: now(),
      action,
      ticketId,
      actor,
      data,
    };
    await fs.appendFile(path.join(this.path, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    this.config.lastEventCursor = event.cursor;
    await this.saveConfig();
    return event;
  }

  async readEvents() {
    const contents = await fs.readFile(path.join(this.path, 'events.jsonl'), 'utf8');
    const lines = contents.split('\n');
    if (contents.endsWith('\n')) lines.pop();
    else {
      try {
        JSON.parse(lines.at(-1));
      } catch {
        lines.pop();
      }
    }
    return lines.filter(Boolean).map((line) => JSON.parse(line));
  }

  async repairEventLog() {
    const eventPath = path.join(this.path, 'events.jsonl');
    const contents = await fs.readFile(eventPath, 'utf8');
    if (contents.endsWith('\n')) return;
    const lastNewline = contents.lastIndexOf('\n');
    const finalRecord = contents.slice(lastNewline + 1);
    try {
      JSON.parse(finalRecord);
      await fs.appendFile(eventPath, '\n');
    } catch {
      await atomicWriteFile(eventPath, lastNewline < 0 ? '' : contents.slice(0, lastNewline + 1));
    }
  }

  async createTicket({ title, body = '', status = this.config.columns[0], assignee = null, labels = [], priority = 'normal', links = [], source = null, messages = [], position = null, actor = null }) {
    return this.withMutationLock(() => this.createTicketUnlocked({ title, body, status, assignee, labels, priority, links, source, messages, position, actor }));
  }

  async createTicketUnlocked({ title, body = '', status = this.config.columns[0], assignee = null, labels = [], priority = 'normal', links = [], source = null, messages = [], position = null, archivedAt = null, actor = null }) {
    await this.refreshConfig();
    if (!title?.trim()) throw new Error('A ticket title is required.');
    this.assertStatus(status);
    const ticket = {
      id: `CB-${String(this.config.nextTicketNumber).padStart(4, '0')}`,
      title: title.trim(),
      body,
      status,
      assignee: assignee || null,
      labels: cleanList(labels),
      priority,
      links: cleanList(links),
      source,
      position: position ?? this.config.nextTicketNumber,
      archivedAt,
      transferredTo: null,
      statusHistory: [{ status, at: now(), by: actor, note: 'Created' }],
      createdAt: now(),
      updatedAt: now(),
      messages,
    };
    this.config.nextTicketNumber += 1;
    await this.saveConfig();
    await this.writeTicket(ticket);
    const event = await this.appendEvent('ticket-created', {
      ticketId: ticket.id,
      actor,
      data: { title: ticket.title, status: ticket.status, assignee: ticket.assignee },
    });
    return { ticket, event };
  }

  async updateTicket(id, changes, { action = 'ticket-updated', actor = null, eventData = {} } = {}) {
    return this.withMutationLock(() => this.updateTicketUnlocked(id, changes, { action, actor, eventData }));
  }

  async updateTicketUnlocked(id, changes, { action = 'ticket-updated', actor = null, eventData = {} } = {}) {
    const ticket = await this.getTicket(id);
    if (changes.title !== undefined) {
      if (typeof changes.title !== 'string' || !changes.title.trim()) throw new Error('A ticket title is required.');
      changes.title = changes.title.trim();
    }
    if (changes.status !== undefined) this.assertStatus(changes.status);
    const original = { ...ticket };
    Object.assign(ticket, changes);
    if (changes.status !== undefined && changes.status !== original.status) {
      ticket.statusHistory = [...(ticket.statusHistory || []), {
        status: changes.status,
        from: original.status,
        at: now(),
        by: actor,
        note: eventData.note || null,
      }];
    }
    if (changes.labels) ticket.labels = cleanList(changes.labels);
    if (changes.links) ticket.links = cleanList(changes.links);
    ticket.updatedAt = now();
    await this.writeTicket(ticket);
    const event = await this.appendEvent(action, { ticketId: id, actor, data: eventData });
    return { ticket, original, event };
  }

  async moveTicket(id, status, { actor = null, note = null } = {}) {
    return this.withMutationLock(async () => {
      this.assertStatus(status);
      const current = await this.getTicket(id);
      if (current.status === status) return { ticket: current, event: null, unchanged: true };
      const result = await this.updateTicketUnlocked(id, { status }, {
        action: 'ticket-moved',
        actor,
        eventData: { from: current.status, to: status, note },
      });
      return { ...result, unchanged: false };
    });
  }

  async assignTicket(id, assignee, { actor = null } = {}) {
    return this.withMutationLock(() => this.updateTicketUnlocked(id, { assignee: assignee || null }, {
      action: 'ticket-assigned',
      actor,
      eventData: { assignee: assignee || null },
    }));
  }

  async reorderTickets(ticketIds, { status = null, actor = null } = {}) {
    return this.withMutationLock(() => this.reorderTicketsUnlocked(ticketIds, { status, actor }));
  }

  async reorderTicketsUnlocked(ticketIds, { status = null, actor = null } = {}) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) throw new Error('At least one ticket id is required to reorder tickets.');
    if (new Set(ticketIds).size !== ticketIds.length) throw new Error('Ticket ids must be unique when reordering.');
    if (status) this.assertStatus(status);
    const tickets = await Promise.all(ticketIds.map((id) => this.getTicket(id)));
    if (tickets.some((ticket) => ticket.archivedAt)) throw new Error('Archived tickets cannot be reordered.');
    for (const [index, ticket] of tickets.entries()) {
      const previousStatus = ticket.status;
      if (status) ticket.status = status;
      if (status && status !== previousStatus) {
        ticket.statusHistory = [...(ticket.statusHistory || []), {
          status,
          from: previousStatus,
          at: now(),
          by: actor,
          note: 'Reordered on board',
        }];
      }
      ticket.position = index + 1;
      ticket.updatedAt = now();
      await this.writeTicket(ticket);
    }
    const event = await this.appendEvent('tickets-reordered', {
      actor,
      data: { status, ticketIds },
    });
    return { tickets, event };
  }

  async archiveTicket(id, { actor = null, transferredTo = null } = {}) {
    return this.withMutationLock(() => this.archiveTicketUnlocked(id, { actor, transferredTo }));
  }

  async archiveTicketUnlocked(id, { actor = null, transferredTo = null } = {}) {
    const ticket = await this.getTicket(id);
    if (ticket.archivedAt) return { ticket, event: null, unchanged: true };
    ticket.archivedAt = now();
    ticket.transferredTo = transferredTo;
    ticket.updatedAt = ticket.archivedAt;
    await this.writeTicket(ticket);
    const event = await this.appendEvent(transferredTo ? 'ticket-transferred' : 'ticket-archived', {
      ticketId: id,
      actor,
      data: { transferredTo },
    });
    return { ticket, event, unchanged: false };
  }

  async restoreTicketUnlocked(id, { actor = null } = {}) {
    const ticket = await this.getTicket(id);
    if (!ticket.archivedAt) return { ticket, event: null, unchanged: true };
    ticket.archivedAt = null;
    ticket.updatedAt = now();
    await this.writeTicket(ticket);
    const event = await this.appendEvent('ticket-restored', {
      ticketId: id,
      actor,
    });
    return { ticket, event, unchanged: false };
  }

  async addComment(id, { author, body, mentions = [], replyTo = null }) {
    return this.withMutationLock(() => this.addCommentUnlocked(id, { author, body, mentions, replyTo }));
  }

  async addCommentUnlocked(id, { author, body, mentions = [], replyTo = null }) {
    if (!author?.trim()) throw new Error('A comment author is required. Pass --as <agent-name>.');
    if (!body?.trim()) throw new Error('A comment body is required.');
    const ticket = await this.getTicket(id);
    const replyTarget = replyTo?.trim() || null;
    if (replyTarget && !ticket.messages.some((message) => message.id === replyTarget)) {
      throw new Error(`Reply target not found: ${replyTarget}`);
    }
    const message = {
      id: `m-${String(ticket.messages.length + 1).padStart(3, '0')}-${crypto.randomUUID().slice(0, 8)}`,
      author: author.trim(),
      body: body.trim(),
      mentions: cleanList([...mentions, ...mentionsIn(body)]),
      replyTo: replyTarget,
      createdAt: now(),
    };
    ticket.messages.push(message);
    ticket.updatedAt = now();
    await this.writeTicket(ticket);
    const event = await this.appendEvent('message-posted', {
      ticketId: id,
      actor: message.author,
      data: { message },
    });
    return { ticket, message, event };
  }

  async activity(since = 0) {
    const cursor = eventCursor(since);
    const allEvents = await this.readEvents();
    const lastEventCursor = allEvents.at(-1)?.cursor ?? 0;
    return { events: allEvents.filter((event) => event.cursor > cursor), cursor: lastEventCursor };
  }

  async inbox(agent, since = 0) {
    if (!agent?.trim()) throw new Error('An agent name is required. Pass --as <agent-name>.');
    const activity = await this.activity(since);
    const messages = activity.events.filter((event) => event.action === 'message-posted' && event.actor !== agent && event.data.message.mentions.includes(agent));
    const assignments = activity.events.filter((event) => event.action === 'ticket-assigned' && event.actor !== agent && event.data.assignee === agent);
    return { agent, messages, assignments, cursor: activity.cursor };
  }
}

export async function withBoardMutationLocks(boards, operation) {
  const uniqueBoards = [...new Map(boards.map((board) => [board.root, board])).values()].sort((left, right) => left.root.localeCompare(right.root));
  async function acquire(index) {
    if (index === uniqueBoards.length) return operation();
    return uniqueBoards[index].withMutationLock(() => acquire(index + 1));
  }
  return acquire(0);
}

export async function transferTicket(sourceBoard, destinationBoard, ticketId, { destinationProjectId = null, actor = null } = {}) {
  if (sourceBoard.root === destinationBoard.root) throw new Error('Choose a different project when moving a ticket across projects.');
  return withBoardMutationLocks([sourceBoard, destinationBoard], async () => {
    await Promise.all([sourceBoard.refreshConfig(), destinationBoard.refreshConfig()]);
    const sourceTicket = await sourceBoard.getTicket(ticketId);
    const recovered = (await destinationBoard.listTickets({ includeArchived: true })).find((ticket) => (
      ticket.source?.type === 'crewboard-transfer'
      && ticket.source.projectPath === sourceBoard.root
      && ticket.source.ticketId === sourceTicket.id
    ));
    if (sourceTicket.archivedAt && (!recovered || sourceTicket.transferredTo?.projectPath !== destinationBoard.root)) {
      throw new Error(`Ticket is already archived: ${ticketId}`);
    }
    const created = recovered ? { ticket: recovered, event: null } : await destinationBoard.createTicketUnlocked({
      title: sourceTicket.title,
      body: sourceTicket.body,
      status: destinationBoard.config.columns.includes(sourceTicket.status) ? sourceTicket.status : destinationBoard.config.columns[0],
      assignee: sourceTicket.assignee,
      labels: sourceTicket.labels,
      priority: sourceTicket.priority,
      links: sourceTicket.links,
      messages: sourceTicket.messages,
      source: {
        type: 'crewboard-transfer',
        projectPath: sourceBoard.root,
        ticketId: sourceTicket.id,
        previousSource: sourceTicket.source ?? null,
      },
      archivedAt: now(),
      actor,
    });
    const archived = sourceTicket.archivedAt ? { ticket: sourceTicket, event: null } : await sourceBoard.archiveTicketUnlocked(ticketId, {
      actor,
      transferredTo: { projectId: destinationProjectId, ticketId: created.ticket.id, projectPath: destinationBoard.root },
    });
    const restored = await destinationBoard.restoreTicketUnlocked(created.ticket.id, { actor });
    return { ticket: restored.ticket, sourceTicket: archived.ticket, event: restored.event || created.event };
  });
}
