import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  const match = contents.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*?)\n?<!-- crewboard-messages\n([\s\S]*?)\n-->\s*$/);
  if (!match) throw new Error(`Invalid Crewboard ticket file: ${filePath}`);
  const values = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(': ');
    if (separator < 1) throw new Error(`Invalid frontmatter in ${filePath}`);
    const key = line.slice(0, separator);
    values[key] = JSON.parse(line.slice(separator + 2));
  }
  return { ...values, body: match[2].trim(), messages: JSON.parse(match[3]) };
}

function ticketFileName(ticketId) {
  if (!/^CB-\d{4,}$/.test(ticketId)) throw new Error(`Invalid ticket id: ${ticketId}`);
  return `${ticketId}.md`;
}

export class BoardStore {
  static async initialize(root, { name = path.basename(root), columns = DEFAULT_COLUMNS } = {}) {
    const boardPath = path.join(root, BOARD_DIRECTORY);
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
    await fs.mkdir(path.join(boardPath, 'tickets'), { recursive: true });
    await fs.writeFile(path.join(boardPath, 'board.json'), `${JSON.stringify(config, null, 2)}\n`);
    await fs.writeFile(path.join(boardPath, 'events.jsonl'), '');
    return new BoardStore(root, config);
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
    await fs.writeFile(path.join(this.path, 'board.json'), `${JSON.stringify(this.config, null, 2)}\n`);
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
    await fs.writeFile(path.join(this.ticketsPath, ticketFileName(ticket.id)), serializeTicket(ticket));
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

  async listTickets({ status, assignee } = {}) {
    let files;
    try {
      files = await fs.readdir(this.ticketsPath);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const tickets = await Promise.all(files.filter((file) => file.endsWith('.md')).sort().map((file) => this.getTicket(file.slice(0, -3))));
    return tickets.filter((ticket) => (!status || ticket.status === status) && (!assignee || ticket.assignee === assignee));
  }

  async appendEvent(action, { ticketId = null, actor = null, data = {} } = {}) {
    await this.refreshConfig();
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
    return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  async createTicket({ title, body = '', status = this.config.columns[0], assignee = null, labels = [], priority = 'normal', links = [], source = null, actor = null }) {
    return this.withMutationLock(() => this.createTicketUnlocked({ title, body, status, assignee, labels, priority, links, source, actor }));
  }

  async createTicketUnlocked({ title, body = '', status = this.config.columns[0], assignee = null, labels = [], priority = 'normal', links = [], source = null, actor = null }) {
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
      createdAt: now(),
      updatedAt: now(),
      messages: [],
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
    if (changes.status) this.assertStatus(changes.status);
    const original = { ...ticket };
    Object.assign(ticket, changes);
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
