export const TICKET_TYPES = ['story', 'task', 'subtask'];
export const PARENT_TYPE = { story: null, task: 'story', subtask: 'task' };

export function normalizeTicketType(type, { required = false } = {}) {
  if (type === undefined || type === null || type === '') {
    if (required) throw new Error('A ticket type is required (story, task, or subtask).');
    return 'task';
  }
  const normalized = String(type).trim().toLowerCase();
  if (!TICKET_TYPES.includes(normalized)) {
    throw new Error(`Unknown ticket type "${type}". Valid types: ${TICKET_TYPES.join(', ')}.`);
  }
  return normalized;
}

export function assertParentLink({ type, parent, parentTicket, allowUnparentedSubtask = false }) {
  const expectedParentType = PARENT_TYPE[type];
  if (!parent) {
    if (type === 'subtask' && !allowUnparentedSubtask) throw new Error('A subtask requires --parent <task-id>.');
    return;
  }
  if (!parentTicket) throw new Error(`Parent ticket not found: ${parent}`);
  if (expectedParentType && parentTicket.type !== expectedParentType) {
    throw new Error(`A ${type} parent must be a ${expectedParentType} (got ${parentTicket.type || 'task'}).`);
  }
  if (type === 'story') throw new Error('A story cannot have a parent ticket; the project is its container.');
}

export function doneStatus(columns) {
  return columns.includes('done') ? 'done' : columns.at(-1);
}

export function isComplete(ticket, columns) {
  return ticket.status === doneStatus(columns);
}

export function childrenOf(ticketId, tickets) {
  return tickets.filter((ticket) => ticket.parent === ticketId);
}

export function ancestorsOf(ticket, tickets) {
  const byId = new Map(tickets.map((item) => [item.id, item]));
  const chain = [];
  let current = ticket;
  const seen = new Set();
  while (current?.parent) {
    if (seen.has(current.parent)) break;
    seen.add(current.parent);
    const parent = byId.get(current.parent);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

export function descendantTasks(story, tickets) {
  return tickets.filter((ticket) => ticket.type === 'task' && ticket.parent === story.id);
}

export function progressFor(ticket, tickets, columns) {
  if (ticket.type === 'story') {
    const tasks = descendantTasks(ticket, tickets);
    const completed = tasks.filter((task) => {
      const subtasks = childrenOf(task.id, tickets).filter((item) => item.type === 'subtask');
      if (subtasks.length) return subtasks.every((item) => isComplete(item, columns));
      return isComplete(task, columns);
    }).length;
    return { completed, total: tasks.length, kind: 'tasks' };
  }
  if (ticket.type === 'task') {
    const subtasks = childrenOf(ticket.id, tickets).filter((item) => item.type === 'subtask');
    if (!subtasks.length) {
      return { completed: isComplete(ticket, columns) ? 1 : 0, total: 1, kind: 'self' };
    }
    return {
      completed: subtasks.filter((item) => isComplete(item, columns)).length,
      total: subtasks.length,
      kind: 'subtasks',
    };
  }
  return { completed: isComplete(ticket, columns) ? 1 : 0, total: 1, kind: 'self' };
}

export function decorateTicket(ticket, tickets, columns) {
  const progress = progressFor(ticket, tickets, columns);
  const childTickets = childrenOf(ticket.id, tickets);
  return {
    ...ticket,
    priority: ticket.priority || 'medium',
    reporter: ticket.reporter ?? null,
    progress,
    children: childTickets.map((child) => child.id),
    childTickets: childTickets.map((child) => ({
      id: child.id,
      title: child.title,
      type: child.type,
      status: child.status,
      assignee: child.assignee ?? null,
      priority: child.priority || 'medium',
      progress: progressFor(child, tickets, columns),
    })),
    ancestors: ancestorsOf(ticket, tickets).map((item) => ({ id: item.id, title: item.title, type: item.type })),
  };
}

export function buildTree(tickets, columns, rootId = null) {
  const decorated = tickets.map((ticket) => decorateTicket(ticket, tickets, columns));
  const byId = new Map(decorated.map((ticket) => [ticket.id, { ...ticket, nodes: [] }]));
  const roots = [];
  for (const ticket of byId.values()) {
    if (ticket.parent && byId.has(ticket.parent)) byId.get(ticket.parent).nodes.push(ticket);
    else if (!rootId) roots.push(ticket);
  }
  if (rootId) {
    const root = byId.get(rootId);
    if (!root) throw new Error(`Ticket not found: ${rootId}`);
    return root;
  }
  const rank = { story: 0, task: 1, subtask: 2 };
  roots.sort((left, right) => (rank[left.type] ?? 9) - (rank[right.type] ?? 9) || (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
  for (const node of byId.values()) {
    node.nodes.sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
  }
  return { roots, tickets: decorated };
}
