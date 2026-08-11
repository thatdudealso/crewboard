import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { ensureAgentsRegistry, listAgents } from './agents.js';
import {
  assertParentLink,
  buildTree,
  decorateTicket,
  normalizeTicketType,
  progressFor,
} from './hierarchy.js';
import { generateTicketId, LEGACY_TICKET_ID, resolveTicketQuery, ticketFileName } from './ids.js';
import { withFileLock } from './lock.js';
import { normalizePriority } from './priority.js';
import { DEFAULT_COLUMNS, cleanList, eventCursor, mentionsIn, now, pathExists } from './utils.js';

const BOARD_DIRECTORY = '.crewboard';

function frontmatter(ticket) {
  const fields = {
    schemaVersion: 1,
    id: ticket.id,
    title: ticket.title,
    type: ticket.type ?? 'task',
    parent: ticket.parent ?? null,
    status: ticket.status,
    assignee: ticket.assignee ?? null,
    assignedBy: ticket.assignedBy ?? null,
    reporter: ticket.reporter ?? null,
    labels: ticket.labels ?? [],
    priority: ticket.priority ?? 'medium',
    links: ticket.links ?? [],
    aliases: ticket.aliases ?? [],
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
  return {
    type: 'task',
    parent: null,
    assignedBy: null,
    reporter: null,
    aliases: [],
    ...values,
    priority: normalizePriority(values.priority ?? 'medium', { fallback: 'medium', strict: false }),
    body: contents.slice(header[0].length, footerIndex).trim(),
    messages: JSON.parse(contents.slice(messageStart, messageEnd)),
  };
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
        idScheme: 'slug-suffix',
      };
      const stagingPath = path.join(absoluteRoot, `.crewboard.initializing-${crypto.randomUUID()}`);
      await fs.mkdir(path.join(stagingPath, 'tickets'), { recursive: true });
      await fs.mkdir(path.join(stagingPath, 'events'), { recursive: true });
      try {
        await atomicWriteFile(path.join(stagingPath, 'board.json'), `${JSON.stringify(config, null, 2)}\n`);
        await fs.writeFile(path.join(stagingPath, 'events.jsonl'), '');
        await ensureAgentsRegistry(stagingPath);
        await fs.rename(stagingPath, boardPath);
      } catch (error) {
        await fs.rm(stagingPath, { recursive: true, force: true });
        throw error;
      }
      const board = new BoardStore(absoluteRoot, config);
      board._migrated = true;
      return board;
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
    const board = new BoardStore(root, config);
    await board.ensureBoardReady();
    return board;
  }

  constructor(root, config) {
    this.root = path.resolve(root);
    this.path = path.join(this.root, BOARD_DIRECTORY);
    this.config = config;
    this._ready = null;
    this._migrated = false;
  }

  get ticketsPath() {
    return path.join(this.path, 'tickets');
  }

  get eventsPath() {
    return path.join(this.path, 'events');
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

  async ensureBoardReady() {
    if (this._migrated) return;
    if (!this._ready) {
      this._ready = this.withMutationLock(async () => {
        if (this._migrated) return;
        await ensureAgentsRegistry(this.path);
        await this.migrateLegacyTicketIdsUnlocked();
        if (this.config.idScheme !== 'slug-suffix') {
          this.config.idScheme = 'slug-suffix';
          await this.saveConfig();
        }
        this._migrated = true;
      });
    }
    await this._ready;
  }

  async migrateLegacyTicketIdsUnlocked() {
    let files;
    try {
      files = await fs.readdir(this.ticketsPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const markdownFiles = files.filter((file) => file.endsWith('.md'));
    const existingIds = new Set(markdownFiles.map((file) => file.slice(0, -3)));
    for (const file of markdownFiles) {
      const legacyId = file.slice(0, -3);
      if (!LEGACY_TICKET_ID.test(legacyId)) continue;
      const filePath = path.join(this.ticketsPath, file);
      const ticket = parseTicket(await fs.readFile(filePath, 'utf8'), filePath);
      if (!LEGACY_TICKET_ID.test(ticket.id)) continue;
      const shortId = generateTicketId(ticket.title, existingIds);
      existingIds.add(shortId);
      existingIds.delete(legacyId);
      const aliases = [...new Set([...(ticket.aliases || []), legacyId, ticket.id].filter((value) => value && value !== shortId))];
      const migrated = {
        ...ticket,
        id: shortId,
        aliases,
        type: ticket.type || 'task',
        parent: ticket.parent ?? null,
        assignedBy: ticket.assignedBy ?? null,
        updatedAt: now(),
      };
      await atomicWriteFile(path.join(this.ticketsPath, ticketFileName(shortId)), serializeTicket(migrated));
      await fs.unlink(filePath);
    }
  }

  async writeTicket(ticket) {
    await atomicWriteFile(path.join(this.ticketsPath, ticketFileName(ticket.id)), serializeTicket(ticket));
  }

  async readTicketFromFile(fileName) {
    const filePath = path.join(this.ticketsPath, fileName);
    return parseTicket(await fs.readFile(filePath, 'utf8'), filePath);
  }

  async listTicketRecords({ includeArchived = false } = {}) {
    if (!this._migrated) await this.ensureBoardReady();
    return this.listTicketRecordsUnlocked({ includeArchived });
  }

  async listTicketRecordsUnlocked({ includeArchived = false } = {}) {
    let files;
    try {
      files = await fs.readdir(this.ticketsPath);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const tickets = await Promise.all(files.filter((file) => file.endsWith('.md')).sort().map((file) => this.readTicketFromFile(file)));
    return tickets
      .filter((ticket) => includeArchived || !ticket.archivedAt)
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
  }

  async resolveTicket(id) {
    const tickets = await this.listTicketRecords({ includeArchived: true });
    return resolveTicketQuery(id, tickets);
  }

  async getTicket(id) {
    const ticket = await this.resolveTicket(id);
    return ticket;
  }

  async getTicketView(id) {
    const tickets = await this.listTicketRecords({ includeArchived: true });
    const ticket = resolveTicketQuery(id, tickets);
    return decorateTicket(ticket, tickets, this.config.columns);
  }

  async getTicketDetail(id) {
    const tickets = await this.listTicketRecords({ includeArchived: true });
    const ticket = decorateTicket(resolveTicketQuery(id, tickets), tickets, this.config.columns);
    const events = (await this.readEvents()).filter((event) => event.ticketId === ticket.id || (ticket.aliases || []).includes(event.ticketId));
    const activity = events
      .filter((event) => event.action !== 'message-posted')
      .map((event) => ({
        id: event.id,
        at: event.at,
        action: event.action,
        actor: event.actor,
        data: event.data,
      }))
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
    const comments = [...(ticket.messages || [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      ticket,
      activity,
      comments,
      breadcrumb: [
        { kind: 'project', id: null, title: this.config.name },
        ...ticket.ancestors.map((item) => ({ kind: item.type, id: item.id, title: item.title })),
        { kind: ticket.type, id: ticket.id, title: ticket.title },
      ],
    };
  }

  async listTickets({ status, assignee, includeArchived = false } = {}) {
    const tickets = await this.listTicketRecords({ includeArchived });
    return tickets
      .filter((ticket) => (!status || ticket.status === status) && (!assignee || ticket.assignee === assignee))
      .map((ticket) => decorateTicket(ticket, tickets, this.config.columns));
  }

  async tree(rootId = null) {
    const tickets = await this.listTicketRecords();
    if (rootId) {
      const root = resolveTicketQuery(rootId, tickets);
      return buildTree(tickets, this.config.columns, root.id);
    }
    return buildTree(tickets, this.config.columns);
  }

  async agents() {
    await this.ensureBoardReady();
    return listAgents(this.path);
  }

  async appendEvent(action, { ticketId = null, actor = null, data = {} } = {}) {
    await this.refreshConfig();
    await this.repairEventLog();
    const events = await this.readEvents();
    const lastEventCursor = events.at(-1)?.cursor ?? 0;
    const parentIds = new Set(events.flatMap((event) => event.parents || []));
    const parents = events
      .filter((event) => !parentIds.has(event.id))
      .map((event) => event.id);
    const event = {
      id: `e-${crypto.randomUUID()}`,
      parents,
      cursor: lastEventCursor + 1,
      at: now(),
      action,
      ticketId,
      actor,
      data,
    };
    await fs.mkdir(this.eventsPath, { recursive: true });
    await atomicWriteFile(path.join(this.eventsPath, `${event.id}.json`), `${JSON.stringify(event)}\n`);
    this.config.lastEventCursor = event.cursor;
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
    const legacyEvents = lines.filter(Boolean).map((line) => ({ event: JSON.parse(line), serialized: line }));
    let eventFiles = [];
    try {
      eventFiles = (await fs.readdir(this.eventsPath)).filter((file) => file.endsWith('.json')).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const storedEvents = await Promise.all(eventFiles.map(async (file) => {
      const serialized = await fs.readFile(path.join(this.eventsPath, file), 'utf8');
      return { event: JSON.parse(serialized), serialized };
    }));
    const uniqueEvents = new Map();
    for (const { event, serialized } of [...legacyEvents, ...storedEvents]) {
      const id = event.id || `e-legacy-${crypto.createHash('sha256').update(serialized).digest('hex')}`;
      if (!uniqueEvents.has(id)) uniqueEvents.set(id, { ...event, id });
    }
    return [...uniqueEvents.values()]
      .map((event, index) => ({ event, index }))
      .sort((left, right) => left.event.cursor - right.event.cursor || String(left.event.id || '').localeCompare(String(right.event.id || '')) || left.index - right.index)
      .map(({ event }, index) => ({ ...event, cursor: index + 1 }));
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

  async createTicket({ title, body = '', status = this.config.columns[0], assignee = null, labels = [], priority = 'medium', links = [], source = null, messages = [], position = null, actor = null, type, parent = null, reporter = null }) {
    return this.withMutationLock(() => this.createTicketUnlocked({ title, body, status, assignee, labels, priority, links, source, messages, position, actor, type, parent, reporter }));
  }

  async createTicketUnlocked({ title, body = '', status = this.config.columns[0], assignee = null, labels = [], priority = 'medium', links = [], source = null, messages = [], position = null, archivedAt = null, actor = null, type, parent = null, assignedBy = null, reporter = null }) {
    await this.refreshConfig();
    await ensureAgentsRegistry(this.path);
    if (!title?.trim()) throw new Error('A ticket title is required.');
    this.assertStatus(status);
    const ticketType = normalizeTicketType(type);
    const ticketPriority = normalizePriority(priority);
    const existingTickets = await this.listTicketRecordsUnlocked({ includeArchived: true });
    const parentId = parent ? resolveTicketQuery(parent, existingTickets).id : null;
    const parentTicket = parentId ? existingTickets.find((ticket) => ticket.id === parentId) : null;
    assertParentLink({ type: ticketType, parent: parentId, parentTicket });
    const existingIds = new Set(existingTickets.flatMap((ticket) => [ticket.id, ...(ticket.aliases || [])]));
    const ticket = {
      id: generateTicketId(title, existingIds),
      title: title.trim(),
      type: ticketType,
      parent: parentId,
      body,
      status,
      assignee: assignee || null,
      assignedBy: assignedBy ?? (assignee ? actor || null : null),
      reporter: reporter || actor || null,
      labels: cleanList(labels),
      priority: ticketPriority,
      links: cleanList(links),
      aliases: [],
      source,
      position: position ?? existingTickets.length + 1,
      archivedAt,
      transferredTo: null,
      statusHistory: [{ status, at: now(), by: actor, note: 'Created' }],
      createdAt: now(),
      updatedAt: now(),
      messages,
    };
    await this.writeTicket(ticket);
    const event = await this.appendEvent('ticket-created', {
      ticketId: ticket.id,
      actor,
      data: { title: ticket.title, status: ticket.status, assignee: ticket.assignee, type: ticket.type, parent: ticket.parent },
    });
    return { ticket: decorateTicket(ticket, [...existingTickets, ticket], this.config.columns), event };
  }

  async updateTicket(id, changes, { action = 'ticket-updated', actor = null, eventData = {} } = {}) {
    return this.withMutationLock(() => this.updateTicketUnlocked(id, changes, { action, actor, eventData }));
  }

  async updateTicketUnlocked(id, changes, { action = 'ticket-updated', actor = null, eventData = {} } = {}) {
    const tickets = await this.listTicketRecordsUnlocked({ includeArchived: true });
    const ticket = { ...resolveTicketQuery(id, tickets) };
    if (changes.title !== undefined) {
      if (typeof changes.title !== 'string' || !changes.title.trim()) throw new Error('A ticket title is required.');
      changes.title = changes.title.trim();
    }
    if (changes.status !== undefined) this.assertStatus(changes.status);
    if (changes.type !== undefined) changes.type = normalizeTicketType(changes.type, { required: true });
    if (changes.priority !== undefined) changes.priority = normalizePriority(changes.priority);
    if (changes.parent !== undefined && changes.parent) {
      changes.parent = resolveTicketQuery(changes.parent, tickets).id;
    }
    const nextType = changes.type ?? ticket.type ?? 'task';
    const nextParent = changes.parent !== undefined ? changes.parent : ticket.parent;
    const parentTicket = nextParent ? tickets.find((item) => item.id === nextParent) : null;
    if (changes.type !== undefined || changes.parent !== undefined) {
      assertParentLink({ type: nextType, parent: nextParent, parentTicket });
    }
    const original = { ...ticket };
    Object.assign(ticket, changes);
    ticket.type = nextType;
    ticket.parent = nextParent ?? null;
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
    const event = await this.appendEvent(action, { ticketId: ticket.id, actor, data: eventData });
    const refreshed = tickets.map((item) => (item.id === ticket.id ? ticket : item));
    return { ticket: decorateTicket(ticket, refreshed, this.config.columns), original, event };
  }

  async moveTicket(id, status, { actor = null, note = null } = {}) {
    return this.withMutationLock(async () => {
      this.assertStatus(status);
      const current = resolveTicketQuery(id, await this.listTicketRecordsUnlocked({ includeArchived: true }));
      if (current.status === status) return { ticket: decorateTicket(current, await this.listTicketRecordsUnlocked({ includeArchived: true }), this.config.columns), event: null, unchanged: true };
      const result = await this.updateTicketUnlocked(current.id, { status }, {
        action: 'ticket-moved',
        actor,
        eventData: { from: current.status, to: status, note },
      });
      return { ...result, unchanged: false };
    });
  }

  async assignTicket(id, assignee, { actor = null } = {}) {
    return this.withMutationLock(() => this.updateTicketUnlocked(id, {
      assignee: assignee || null,
      assignedBy: assignee ? actor || null : null,
    }, {
      action: 'ticket-assigned',
      actor,
      eventData: { assignee: assignee || null, assignedBy: assignee ? actor || null : null },
    }));
  }

  async reorderTickets(ticketIds, { status = null, actor = null } = {}) {
    return this.withMutationLock(() => this.reorderTicketsUnlocked(ticketIds, { status, actor }));
  }

  async reorderTicketsUnlocked(ticketIds, { status = null, actor = null } = {}) {
    if (!Array.isArray(ticketIds) || ticketIds.length === 0) throw new Error('At least one ticket id is required to reorder tickets.');
    if (new Set(ticketIds).size !== ticketIds.length) throw new Error('Ticket ids must be unique when reordering.');
    if (status) this.assertStatus(status);
    const allTickets = await this.listTicketRecordsUnlocked({ includeArchived: true });
    const tickets = ticketIds.map((id) => resolveTicketQuery(id, allTickets));
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
      data: { status, ticketIds: tickets.map((ticket) => ticket.id) },
    });
    return { tickets: tickets.map((ticket) => decorateTicket(ticket, allTickets, this.config.columns)), event };
  }

  async archiveTicket(id, { actor = null, transferredTo = null } = {}) {
    return this.withMutationLock(() => this.archiveTicketUnlocked(id, { actor, transferredTo }));
  }

  async archiveTicketUnlocked(id, { actor = null, transferredTo = null } = {}) {
    const ticket = resolveTicketQuery(id, await this.listTicketRecordsUnlocked({ includeArchived: true }));
    if (ticket.archivedAt) return { ticket, event: null, unchanged: true };
    ticket.archivedAt = now();
    ticket.transferredTo = transferredTo;
    ticket.updatedAt = ticket.archivedAt;
    await this.writeTicket(ticket);
    const event = await this.appendEvent(transferredTo ? 'ticket-transferred' : 'ticket-archived', {
      ticketId: ticket.id,
      actor,
      data: { transferredTo },
    });
    return { ticket, event, unchanged: false };
  }

  async restoreTicketUnlocked(id, { actor = null } = {}) {
    const ticket = resolveTicketQuery(id, await this.listTicketRecordsUnlocked({ includeArchived: true }));
    if (!ticket.archivedAt) return { ticket, event: null, unchanged: true };
    ticket.archivedAt = null;
    ticket.updatedAt = now();
    await this.writeTicket(ticket);
    const event = await this.appendEvent('ticket-restored', {
      ticketId: ticket.id,
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
    const ticket = resolveTicketQuery(id, await this.listTicketRecordsUnlocked({ includeArchived: true }));
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
      ticketId: ticket.id,
      actor: message.author,
      data: { message },
    });
    return { ticket, message, event };
  }

  async activity(since = 0) {
    const checkpoint = eventCursor(since);
    const allEvents = await this.readEvents();
    const eventById = new Map(allEvents.map((event) => [event.id, event]));
    const processed = new Set();
    const pending = [...checkpoint.eventIds];
    while (pending.length) {
      const id = pending.pop();
      if (processed.has(id)) continue;
      processed.add(id);
      pending.push(...(eventById.get(id)?.parents || []));
    }
    const events = checkpoint.eventIds.size
      ? allEvents.filter((event) => !processed.has(event.id))
      : allEvents.filter((event) => event.cursor > checkpoint.legacyCursor);
    const parentIds = new Set(allEvents.flatMap((event) => event.parents || []));
    const heads = allEvents
      .filter((event) => !parentIds.has(event.id))
      .map((event) => event.id)
      .sort();
    const cursor = `v1.${Buffer.from(JSON.stringify(heads)).toString('base64url')}`;
    return { events, cursor };
  }

  async inbox(agent, since = 0) {
    if (!agent?.trim()) throw new Error('An agent name is required. Pass --as <agent-name>.');
    const activity = await this.activity(since);
    const messages = activity.events.filter((event) => event.action === 'message-posted' && event.actor !== agent && event.data.message.mentions.includes(agent));
    const assignments = activity.events.filter((event) => event.action === 'ticket-assigned' && event.actor !== agent && event.data.assignee === agent);
    return { agent, messages, assignments, cursor: activity.cursor };
  }

  progress(ticket) {
    return progressFor(ticket, [], this.config.columns);
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
    const sourceTicket = resolveTicketQuery(ticketId, await sourceBoard.listTicketRecordsUnlocked({ includeArchived: true }));
    const recovered = (await destinationBoard.listTicketRecordsUnlocked({ includeArchived: true })).find((ticket) => (
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
      type: sourceTicket.type,
      parent: null,
      status: destinationBoard.config.columns.includes(sourceTicket.status) ? sourceTicket.status : destinationBoard.config.columns[0],
      assignee: sourceTicket.assignee,
      assignedBy: sourceTicket.assignedBy,
      reporter: sourceTicket.reporter,
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
    const archived = sourceTicket.archivedAt ? { ticket: sourceTicket, event: null } : await sourceBoard.archiveTicketUnlocked(sourceTicket.id, {
      actor,
      transferredTo: { projectId: destinationProjectId, ticketId: created.ticket.id, projectPath: destinationBoard.root },
    });
    const restored = await destinationBoard.restoreTicketUnlocked(created.ticket.id, { actor });
    return { ticket: restored.ticket, sourceTicket: archived.ticket, event: restored.event || created.event };
  });
}
