const state = {
  data: null,
  view: 'board',
  projectId: null,
  notice: '',
  loading: true,
  filters: { text: '', type: '', assignee: '', label: '', priority: '', project: '' },
  expanded: {},
  detail: null,
};

const TYPE_ICON = {
  story: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 2h7l3 3v9H3V2zm7 1v2h2"/></svg>',
  task: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M3.5 3.5h9v9h-9z"/><path fill="none" stroke="currentColor" stroke-width="1.5" d="M5.5 8l2 2 3.5-4"/></svg>',
  subtask: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M3 3v5h6"/><path fill="none" stroke="currentColor" stroke-width="1.5" d="M7 6l2 2-2 2"/></svg>',
};

const PRIORITY_ICON = {
  highest: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#c48888" d="M8 2l4 5H4l4-5zm0 12l4-5H4l4 5z"/></svg>',
  high: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#c4a35a" d="M8 3l4 6H4l4-6z"/></svg>',
  medium: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#9aa3ae" d="M3 7h10v2H3z"/></svg>',
  low: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#8fbc8f" d="M8 13L4 7h8l-4 6z"/></svg>',
  lowest: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#6b7380" d="M8 3l4 5H4l4-5zm0 10l4-5H4l4 5z"/></svg>',
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', 'x-crewboard-csrf': window.CREWBOARD_CSRF },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Request failed.');
  return data;
}

const project = () => state.data?.projects.find((item) => item.id === state.projectId) || state.data?.projects[0];
const agentRole = (item, name) => (item.agents || []).find((agent) => agent.name === name);

function matchesFilters(item, ticket) {
  const f = state.filters;
  if (f.project && item.id !== f.project) return false;
  if (f.type && (ticket.type || 'task') !== f.type) return false;
  if (f.assignee && ticket.assignee !== f.assignee) return false;
  if (f.priority && (ticket.priority || 'medium') !== f.priority) return false;
  if (f.label && !(ticket.labels || []).includes(f.label)) return false;
  if (f.text) {
    const hay = `${ticket.id} ${ticket.title} ${ticket.body || ''} ${(ticket.labels || []).join(' ')}`.toLowerCase();
    if (!hay.includes(f.text.toLowerCase())) return false;
  }
  return true;
}

function filteredTickets(item) {
  return (item.tickets || []).filter((ticket) => matchesFilters(item, ticket));
}

function activeFilterChips() {
  return Object.entries(state.filters).filter(([, value]) => value).map(([key, value]) => ({ key, value }));
}

function progressBar(progress) {
  if (!progress || !progress.total) return '';
  const pct = Math.round((progress.completed / progress.total) * 100);
  return `<div class="progress-bar" title="${progress.completed}/${progress.total}"><span style="width:${pct}%"></span></div><div class="progress-label">${progress.completed} of ${progress.total} done</div>`;
}

function assigneeChip(item, ticket) {
  if (!ticket.assignee) return '<span class="chip">unassigned</span>';
  const leader = agentRole(item, ticket.assignee)?.role === 'leader';
  return `<span class="chip ${leader ? 'leader' : ''}">@${escapeHtml(ticket.assignee)}${leader ? ' · leader' : ''}</span>`;
}

function ticketCard(item, ticket) {
  const type = ticket.type || 'task';
  const priority = ticket.priority || 'medium';
  return `<article class="ticket ${escapeHtml(type)}" draggable="true" data-ticket="${escapeHtml(ticket.id)}" data-project="${escapeHtml(item.id)}" tabindex="0">
    <div class="ticket-meta">
      <span class="type-icon" title="${escapeHtml(type)}">${TYPE_ICON[type] || TYPE_ICON.task}</span>
      <span>${escapeHtml(ticket.id)}</span>
      <span class="priority-icon" title="${escapeHtml(priority)}">${PRIORITY_ICON[priority] || PRIORITY_ICON.medium}</span>
    </div>
    <div class="ticket-title">${escapeHtml(ticket.title)}</div>
    <div class="ticket-footer">
      ${assigneeChip(item, ticket)}
      <div class="quick">
        <button class="button ghost" data-quick-status="${escapeHtml(ticket.id)}" data-project="${escapeHtml(item.id)}">Move</button>
        <button class="button ghost" data-quick-assign="${escapeHtml(ticket.id)}" data-project="${escapeHtml(item.id)}">Assign</button>
        <button class="button ghost" data-quick-priority="${escapeHtml(ticket.id)}" data-project="${escapeHtml(item.id)}">Priority</button>
      </div>
    </div>
    ${type === 'subtask' ? '' : progressBar(ticket.progress)}
  </article>`;
}

function orderedColumnTickets(item, status) {
  const tickets = filteredTickets(item).filter((ticket) => ticket.status === status);
  const byParent = new Map();
  for (const ticket of tickets) {
    const key = ticket.parent || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(ticket);
  }
  const rank = { story: 0, task: 1, subtask: 2 };
  const roots = tickets.filter((ticket) => !ticket.parent || !tickets.some((candidate) => candidate.id === ticket.parent))
    .sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || (a.position || 0) - (b.position || 0));
  const ordered = [];
  const visit = (ticket) => {
    ordered.push(ticket);
    for (const child of (byParent.get(ticket.id) || []).sort((a, b) => (a.position || 0) - (b.position || 0))) visit(child);
  };
  for (const root of roots) visit(root);
  for (const ticket of tickets) if (!ordered.includes(ticket)) ordered.push(ticket);
  return ordered;
}

function renderFilters(item) {
  const assignees = [...new Set((item?.tickets || []).map((ticket) => ticket.assignee).filter(Boolean))];
  const labels = [...new Set((item?.tickets || []).flatMap((ticket) => ticket.labels || []))];
  const chips = activeFilterChips().map(({ key, value }) => `<span class="chip active">${escapeHtml(key)}: ${escapeHtml(value)} <button type="button" data-clear-filter="${escapeHtml(key)}" aria-label="Clear ${escapeHtml(key)}">×</button></span>`).join('');
  return `<section class="filters" aria-label="Filters">
    <input class="search" data-filter="text" value="${escapeHtml(state.filters.text)}" placeholder="Search id, title, body, labels">
    <select data-filter="type"><option value="">All types</option>${['story', 'task', 'subtask'].map((type) => `<option ${state.filters.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select>
    <select data-filter="assignee"><option value="">All assignees</option>${assignees.map((name) => `<option ${state.filters.assignee === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>
    <select data-filter="priority"><option value="">All priorities</option>${['highest', 'high', 'medium', 'low', 'lowest'].map((priority) => `<option ${state.filters.priority === priority ? 'selected' : ''}>${priority}</option>`).join('')}</select>
    <select data-filter="label"><option value="">All labels</option>${labels.map((label) => `<option ${state.filters.label === label ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
    <select data-filter="project"><option value="">Current project</option>${(state.data?.projects || []).map((projectItem) => `<option value="${escapeHtml(projectItem.id)}" ${state.filters.project === projectItem.id ? 'selected' : ''}>${escapeHtml(projectItem.name)}</option>`).join('')}</select>
    <button class="button ghost" data-clear-filters="true">Clear</button>
    <div class="filter-state">Active filters: ${chips || '<span class="chip">none</span>'}</div>
  </section>`;
}

function renderBoard(item) {
  if (!item) return `<section class="empty"><h2>No project selected</h2><p>Approve or create a project to open the board.</p></section>`;
  if (!item.available) return `<section class="empty">${escapeHtml(item.error || 'Board unavailable.')}</section>`;
  const leaders = (item.agents || []).filter((agent) => agent.role === 'leader');
  return `<section class="panel">
    <div class="topbar"><div><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.organization)} · <span class="origin">${escapeHtml(item.origin)}</span></p>
      ${leaders.length ? `<div class="actions" style="margin-top:8px">${leaders.map((agent) => `<span class="chip leader">@${escapeHtml(agent.name)} · leader</span>`).join('')}</div>` : ''}
    </div></div>
    <div class="board">${item.columns.map((status) => {
      const tickets = orderedColumnTickets(item, status);
      return `<section class="column" data-column="${escapeHtml(status)}" data-project="${escapeHtml(item.id)}">
        <div class="column-heading"><span>${escapeHtml(status)} <span class="wip">WIP ${tickets.length}</span></span><span class="count">${tickets.length}</span></div>
        <div class="ticket-list">${tickets.map((ticket) => ticketCard(item, ticket)).join('') || '<div class="empty">No tickets in this column</div>'}</div>
      </section>`;
    }).join('')}</div>
  </section>`;
}

function renderBacklog(item) {
  const tickets = filteredTickets(item || { tickets: [] }).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  if (!tickets.length) return `<section class="empty"><h2>Backlog is empty</h2><p>Create a story or clear filters to see work.</p></section>`;
  return `<section class="panel"><h2>Backlog</h2><div class="backlog">${tickets.map((ticket) => `
    <button class="row" data-open-ticket="${escapeHtml(ticket.id)}" data-project="${escapeHtml(item.id)}" style="width:100%;text-align:left">
      <span class="type-icon">${TYPE_ICON[ticket.type] || TYPE_ICON.task}</span>
      <span class="id">${escapeHtml(ticket.id)}</span>
      <span>${escapeHtml(ticket.title)}</span>
      <span>${escapeHtml(ticket.status)}</span>
      <span>@${escapeHtml(ticket.assignee || '—')}</span>
      <span>${PRIORITY_ICON[ticket.priority] || PRIORITY_ICON.medium} ${escapeHtml(ticket.priority || 'medium')}</span>
      <span class="progress-label">${ticket.progress?.completed ?? 0}/${ticket.progress?.total ?? 0}</span>
    </button>`).join('')}</div></section>`;
}

function renderTree(item) {
  if (!item?.available) return `<section class="empty"><h2>Structure unavailable</h2><p>Select an approved project.</p></section>`;
  const tickets = filteredTickets(item);
  const byParent = new Map();
  for (const ticket of tickets) {
    const key = ticket.parent || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(ticket);
  }
  const roots = tickets.filter((ticket) => !ticket.parent || !tickets.some((candidate) => candidate.id === ticket.parent))
    .sort((a, b) => ({ story: 0, task: 1, subtask: 2 }[a.type] ?? 9) - ({ story: 0, task: 1, subtask: 2 }[b.type] ?? 9) || (a.position || 0) - (b.position || 0));
  const lines = [];
  const walk = (ticket, depth) => {
    const key = ticket.id;
    const children = (byParent.get(ticket.id) || []).sort((a, b) => (a.position || 0) - (b.position || 0));
    const open = state.expanded[key] !== false;
    lines.push(`<div class="row child-${depth}">
      <button class="tree-toggle" data-toggle-tree="${escapeHtml(key)}" aria-expanded="${open}">${children.length ? (open ? '−' : '+') : '·'}</button>
      <span class="id">${escapeHtml(ticket.id)}</span>
      <button class="button ghost" data-open-ticket="${escapeHtml(ticket.id)}" data-project="${escapeHtml(item.id)}" style="justify-content:flex-start;box-shadow:none;border:0;padding:0;min-height:auto">${TYPE_ICON[ticket.type] || ''} ${escapeHtml(ticket.title)}</button>
      <span>${escapeHtml(ticket.status)}</span>
      <span>@${escapeHtml(ticket.assignee || '—')}</span>
      <span>${escapeHtml(ticket.priority || 'medium')}</span>
      <span>${ticket.progress?.completed ?? 0}/${ticket.progress?.total ?? 0}</span>
      ${ticket.progress?.total ? `<div style="grid-column:1/-1">${progressBar(ticket.progress)}</div>` : ''}
    </div>`);
    if (open) for (const child of children) walk(child, Math.min(depth + 1, 2));
  };
  if (!roots.length) return `<section class="empty"><h2>No hierarchy yet</h2><p>Create a story, then nest tasks and subtasks.</p></section>`;
  for (const root of roots) walk(root, 0);
  return `<section class="panel"><div class="breadcrumbs"><span>project · ${escapeHtml(item.name)}</span><span>structure</span></div><h2>Structure</h2><p>Expandable outline with status and progress inline.</p><div class="tree">${lines.join('')}</div></section>`;
}

function renderAgents(item) {
  const agents = item?.agents || [];
  return `<section class="panel"><h2>Fleet agents</h2><p>Leader triages and assigns; scouts and workers are ordinary agents.</p><div class="panel-grid">${agents.map((agent) => `<article class="project-card"><div class="small">${agent.role === 'leader' ? '<span class="chip leader">leader</span>' : `<span class="chip">${escapeHtml(agent.role)}</span>`}</div><h2>@${escapeHtml(agent.name)}</h2><p>${escapeHtml(agent.description)}</p></article>`).join('') || '<div class="empty">No agents registered.</div>'}</div></section>`;
}

function renderProjects() {
  const pending = state.data?.pendingProjects || [];
  const archived = state.data?.archivedProjects || [];
  const active = state.data?.projects || [];
  return `<section class="panel"><h2>Captain controls</h2><p>Create, discover, approve, and organize projects.</p>
    <div class="panel-grid">
      <form id="create-project" class="project-card"><h2>Create project</h2><div class="form-row"><label>Name</label><input name="name" required></div><div class="form-row"><label>Local board path</label><input name="boardPath" required></div><div class="form-row"><label>Organization</label><input name="organization" value="Unsorted"></div><button class="button primary">Create</button></form>
      <form id="discover-projects" class="project-card"><h2>Discover</h2><div class="form-row"><label>Source</label><select name="source"><option value="local">Local</option><option value="claude">Claude</option><option value="chatgpt">ChatGPT</option></select></div><div class="form-row"><label>Root</label><input name="root"></div><button class="button">Scan</button></form>
    </div><p class="notice">${escapeHtml(state.notice || '')}</p></section>
    <section class="panel"><h2>Pending</h2><div class="panel-grid">${pending.map((item) => `<article class="project-card"><div class="chip">${escapeHtml(item.origin)}</div><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.path || item.sourceLocation || 'No path')}</p><button class="button primary" data-approve="${escapeHtml(item.id)}">Approve</button></article>`).join('') || '<div class="empty">Nothing waiting</div>'}</div></section>
    <section class="panel"><h2>Active</h2><div class="panel-grid">${active.map((item) => `<article class="project-card"><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.boardPath || '')}</p><div class="actions"><button class="button" data-rename="${escapeHtml(item.id)}">Rename</button><button class="button" data-organize="${escapeHtml(item.id)}">Organize</button><button class="button danger" data-archive="${escapeHtml(item.id)}">Archive</button></div></article>`).join('')}</div></section>
    ${archived.length ? `<section class="panel"><h2>Archived</h2><div class="panel-grid">${archived.map((item) => `<article class="project-card"><h2>${escapeHtml(item.name)}</h2><button class="button" data-restore="${escapeHtml(item.id)}">Restore</button></article>`).join('')}</div></section>` : ''}`;
}

function renderNavigation() {
  const active = state.data?.projects || [];
  const pending = state.data?.pendingProjects || [];
  document.querySelector('#project-nav').innerHTML = active.map((item) => `<button class="project-button ${project()?.id === item.id ? 'active' : ''}" data-project="${escapeHtml(item.id)}"><span class="origin">${escapeHtml(item.origin)}</span><span>${escapeHtml(item.name)}</span></button>`).join('') || '<p class="notice">No approved projects</p>';
  document.querySelector('#pending-nav').innerHTML = pending.map((item) => `<button class="project-button" data-view="projects"><span class="origin">${escapeHtml(item.origin)}</span><span>${escapeHtml(item.name)}</span></button>`).join('') || '<p class="notice">Nothing waiting</p>';
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
}

function render() {
  renderNavigation();
  const selected = project();
  if (state.filters.project) {
    const forced = state.data?.projects.find((item) => item.id === state.filters.project);
    if (forced) state.projectId = forced.id;
  }
  const titles = { board: 'Board', backlog: 'Backlog', tree: 'Structure', agents: 'Agents', projects: 'Projects' };
  const subtitle = {
    board: selected ? `${selected.name} · status columns` : 'Fleet overview',
    backlog: 'Ordered work list for the selected project',
    tree: 'Expandable project › story › task › subtask',
    agents: 'Roles and the board leader',
    projects: 'Approval and organization',
  }[state.view];
  let body = state.loading ? '<section class="loading">Loading board…</section>' : '';
  if (!state.loading) {
    if (state.view === 'board') body = renderFilters(selected) + renderBoard(selected);
    else if (state.view === 'backlog') body = renderFilters(selected) + renderBacklog(selected);
    else if (state.view === 'tree') body = renderFilters(selected) + renderTree(selected);
    else if (state.view === 'agents') body = renderAgents(selected);
    else body = renderProjects();
  }
  document.querySelector('#app').innerHTML = `<div class="topbar"><div><div class="breadcrumbs"><span>Crewboard</span><span>${escapeHtml(selected?.name || 'fleet')}</span><span>${escapeHtml(state.view)}</span></div><h1>${escapeHtml(titles[state.view])}</h1><p>${escapeHtml(subtitle)}</p></div><div class="actions">${selected && state.view !== 'projects' ? '<button class="button" data-open-new-ticket="true">New ticket</button>' : ''}<button class="button" data-refresh="true">Refresh</button></div></div>${body}`;
  bindBoard();
}

function bindBoard() {
  document.querySelectorAll('.ticket').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      card.classList.add('dragging');
      event.dataTransfer.setData('text/plain', JSON.stringify({ ticketId: card.dataset.ticket, projectId: card.dataset.project }));
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-quick-status],[data-quick-assign],[data-quick-priority]')) return;
      openTicket(card.dataset.project, card.dataset.ticket);
    });
  });
  document.querySelectorAll('.ticket-list').forEach((list) => list.addEventListener('dragover', (event) => event.preventDefault()));
  document.querySelectorAll('.column').forEach((column) => column.addEventListener('drop', async (event) => {
    event.preventDefault();
    const payload = JSON.parse(event.dataTransfer.getData('text/plain'));
    if (payload.projectId !== column.dataset.project) return;
    const list = column.querySelector('.ticket-list');
    const dragged = document.querySelector('.ticket.dragging');
    const before = [...list.querySelectorAll('.ticket:not(.dragging)')].find((card) => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    if (dragged) list.insertBefore(dragged, before || null);
    const ticketIds = [...list.querySelectorAll('.ticket')].map((card) => card.dataset.ticket);
    try {
      await api(`/api/projects/${column.dataset.project}/tickets/${payload.ticketId}/reorder`, { method: 'POST', body: { ticketIds, status: column.dataset.column } });
      await refresh();
    } catch (error) {
      state.notice = error.message;
      render();
    }
  }));
}

function openModal(content) {
  document.querySelector('#modal').innerHTML = content;
  document.querySelector('#modal-backdrop').classList.add('open');
}
function closeModal() {
  document.querySelector('#modal-backdrop').classList.remove('open');
  state.detail = null;
}

function linkify(links) {
  return (links || []).map((link) => {
    const href = /^(https?:|\/|\.)/.test(link) ? link : `https://${link}`;
    return `<div class="links"><a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(link)}</a></div>`;
  }).join('') || '<p class="notice">No links</p>';
}

async function openTicket(projectId, ticketId) {
  try {
    const detail = await api(`/api/projects/${projectId}/tickets/${ticketId}`);
    state.detail = detail;
    const item = state.data.projects.find((candidate) => candidate.id === projectId);
    const ticket = detail.ticket;
    const destinations = state.data.projects.filter((candidate) => candidate.id !== projectId).map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</option>`).join('');
    const crumbs = (detail.breadcrumb || []).map((crumb) => `<span>${escapeHtml(crumb.kind)}${crumb.id ? ` · ${escapeHtml(crumb.id)}` : ''}</span>`).join('');
    openModal(`<div class="modal-head"><div><div class="breadcrumbs">${crumbs}</div><h2>${escapeHtml(ticket.title)}</h2>
      <p class="ticket-meta">${TYPE_ICON[ticket.type] || ''} ${escapeHtml(ticket.id)} · ${PRIORITY_ICON[ticket.priority] || ''} ${escapeHtml(ticket.priority)} · ${escapeHtml(ticket.status)}</p></div>
      <button class="button" data-close-modal="true">Close</button></div>
      <div class="detail-grid">
        <div>
          <section class="panel"><h2>Description</h2><p style="white-space:pre-wrap;color:var(--text)">${escapeHtml(ticket.body || 'No description yet.')}</p></section>
          <section class="panel"><h2>Children</h2>${progressBar(ticket.progress)}
            ${(ticket.childTickets || []).length ? `<table class="child-table"><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Assignee</th></tr></thead><tbody>
              ${ticket.childTickets.map((child) => `<tr><td class="id">${escapeHtml(child.id)}</td><td>${escapeHtml(child.title)}</td><td>${escapeHtml(child.status)}</td><td>${escapeHtml(child.assignee || '—')}</td></tr>`).join('')}
            </tbody></table>` : '<p class="notice">No children</p>'}</section>
          <section class="panel"><h2>Activity</h2><div class="activity">${(detail.activity || []).map((entry) => `<div class="feed-item"><div class="meta">${escapeHtml(entry.at)} · ${escapeHtml(entry.action)}${entry.actor ? ` · @${escapeHtml(entry.actor)}` : ''}</div><div>${escapeHtml(JSON.stringify(entry.data || {}))}</div></div>`).join('') || '<p class="notice">No activity yet</p>'}</div></section>
          <section class="panel"><h2>Comments</h2><div class="comments">${(detail.comments || []).map((message) => `<div class="feed-item"><div class="meta">@${escapeHtml(message.author)} · ${escapeHtml(message.createdAt)}</div><div style="white-space:pre-wrap">${escapeHtml(message.body)}</div></div>`).join('') || '<p class="notice">No comments yet</p>'}
            <form id="message-form" data-project="${escapeHtml(projectId)}" data-ticket="${escapeHtml(ticketId)}"><div class="form-row"><label>Comment</label><textarea name="body" required></textarea></div><button class="button">Post</button></form>
          </div></section>
        </div>
        <aside class="props">
          <div class="prop"><label>Type</label>${TYPE_ICON[ticket.type] || ''} ${escapeHtml(ticket.type)}</div>
          <div class="prop"><label>Status</label>${escapeHtml(ticket.status)}</div>
          <div class="prop"><label>Priority</label>${PRIORITY_ICON[ticket.priority] || ''} ${escapeHtml(ticket.priority)}</div>
          <div class="prop"><label>Assignee</label>@${escapeHtml(ticket.assignee || '—')}</div>
          <div class="prop"><label>Assigned by</label>@${escapeHtml(ticket.assignedBy || '—')}</div>
          <div class="prop"><label>Reporter</label>@${escapeHtml(ticket.reporter || '—')}</div>
          <div class="prop"><label>Labels</label>${(ticket.labels || []).map((label) => `<span class="chip">${escapeHtml(label)}</span>`).join(' ') || '—'}</div>
          <div class="prop"><label>Created</label>${escapeHtml(ticket.createdAt)}</div>
          <div class="prop"><label>Updated</label>${escapeHtml(ticket.updatedAt)}</div>
          <div class="prop"><label>Status history</label>${(ticket.statusHistory || []).slice().reverse().map((entry) => `<div class="notice">${escapeHtml(entry.at)} → ${escapeHtml(entry.status)}${entry.by ? ` (@${escapeHtml(entry.by)})` : ''}${entry.note ? `: ${escapeHtml(entry.note)}` : ''}</div>`).join('') || '—'}</div>
          <div class="prop"><label>Links</label>${linkify(ticket.links)}</div>
          <form id="ticket-form" data-project="${escapeHtml(projectId)}" data-ticket="${escapeHtml(ticketId)}">
            <div class="form-row"><label>Title</label><input name="title" value="${escapeHtml(ticket.title)}"></div>
            <div class="form-row"><label>Status</label><select name="status">${item.columns.map((status) => `<option ${status === ticket.status ? 'selected' : ''}>${escapeHtml(status)}</option>`).join('')}</select></div>
            <div class="form-row"><label>Assignee</label><input name="assignee" value="${escapeHtml(ticket.assignee || '')}"></div>
            <div class="form-row"><label>Priority</label><select name="priority">${['highest', 'high', 'medium', 'low', 'lowest'].map((priority) => `<option ${priority === ticket.priority ? 'selected' : ''}>${priority}</option>`).join('')}</select></div>
            <div class="form-row"><label>Type</label><select name="type">${['story', 'task', 'subtask'].map((type) => `<option ${type === ticket.type ? 'selected' : ''}>${type}</option>`).join('')}</select></div>
            <div class="form-row"><label>Parent</label><input name="parent" value="${escapeHtml(ticket.parent || '')}"></div>
            <div class="form-row"><label>Labels</label><input name="labels" value="${escapeHtml((ticket.labels || []).join(', '))}"></div>
            <div class="form-row"><label>Links</label><input name="links" value="${escapeHtml((ticket.links || []).join(', '))}"></div>
            <div class="form-row"><label>Body</label><textarea name="body">${escapeHtml(ticket.body || '')}</textarea></div>
            <div class="actions"><button class="button primary">Save</button>${destinations ? `<select id="transfer-destination">${destinations}</select><button class="button" type="button" data-transfer="${escapeHtml(ticketId)}" data-project="${escapeHtml(projectId)}">Move project</button>` : ''}</div>
          </form>
        </aside>
      </div>`);
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

async function refresh() {
  state.loading = true;
  render();
  try {
    state.data = await api('/api/board');
    if (!state.projectId && state.data.projects.length) state.projectId = state.data.projects[0].id;
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    state.notice = error.message;
    render();
  }
}

document.addEventListener('input', (event) => {
  const filter = event.target.dataset.filter;
  if (!filter) return;
  state.filters[filter] = event.target.value;
  render();
});

document.addEventListener('change', (event) => {
  const filter = event.target.dataset.filter;
  if (!filter) return;
  state.filters[filter] = event.target.value;
  render();
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, [data-open-ticket]');
  if (!target) return;
  try {
    if (target.dataset.view) { state.view = target.dataset.view; render(); }
    else if (target.dataset.project && !target.dataset.openTicket && !target.dataset.quickStatus && !target.dataset.quickAssign && !target.dataset.quickPriority && !target.dataset.transfer) { state.projectId = target.dataset.project; state.view = 'board'; render(); }
    else if (target.dataset.refresh) await refresh();
    else if (target.dataset.closeModal) closeModal();
    else if (target.dataset.clearFilters) { state.filters = { text: '', type: '', assignee: '', label: '', priority: '', project: '' }; render(); }
    else if (target.dataset.clearFilter) { state.filters[target.dataset.clearFilter] = ''; render(); }
    else if (target.dataset.toggleTree) { const key = target.dataset.toggleTree; state.expanded[key] = !(state.expanded[key] !== false); render(); }
    else if (target.dataset.openTicket) await openTicket(target.dataset.project, target.dataset.openTicket);
    else if (target.dataset.openNewTicket) {
      const item = project();
      openModal(`<div class="modal-head"><h2>New ticket</h2><button class="button" data-close-modal="true">Close</button></div>
        <form id="ticket-form" data-project="${escapeHtml(item.id)}">
          <div class="form-row"><label>Title</label><input name="title" required></div>
          <div class="two-col"><div class="form-row"><label>Type</label><select name="type"><option>story</option><option selected>task</option><option>subtask</option></select></div><div class="form-row"><label>Parent</label><input name="parent"></div></div>
          <div class="two-col"><div class="form-row"><label>Priority</label><select name="priority"><option>highest</option><option>high</option><option selected>medium</option><option>low</option><option>lowest</option></select></div><div class="form-row"><label>Status</label><select name="status">${item.columns.map((status) => `<option>${escapeHtml(status)}</option>`).join('')}</select></div></div>
          <div class="form-row"><label>Body</label><textarea name="body"></textarea></div>
          <button class="button primary">Create</button></form>`);
    } else if (target.dataset.quickStatus) {
      const item = state.data.projects.find((candidate) => candidate.id === target.dataset.project);
      const status = prompt(`Move to status (${item.columns.join(', ')})`, item.columns[0]);
      if (status) { await api(`/api/projects/${target.dataset.project}/tickets/${target.dataset.quickStatus}`, { method: 'PATCH', body: { status, actor: 'captain-web' } }); await refresh(); }
    } else if (target.dataset.quickAssign) {
      const assignee = prompt('Assign to agent', 'firstmate');
      if (assignee !== null) { await api(`/api/projects/${target.dataset.project}/tickets/${target.dataset.quickAssign}`, { method: 'PATCH', body: { assignee, actor: 'firstmate' } }); await refresh(); }
    } else if (target.dataset.quickPriority) {
      const priority = prompt('Priority (highest|high|medium|low|lowest)', 'medium');
      if (priority) { await api(`/api/projects/${target.dataset.project}/tickets/${target.dataset.quickPriority}`, { method: 'PATCH', body: { priority, actor: 'captain-web' } }); await refresh(); }
    } else if (target.dataset.approve) {
      const candidate = state.data.pendingProjects.find((item) => item.id === target.dataset.approve);
      const boardPath = candidate.boardPath || prompt(`Local board path for ${candidate.name}:`, '') || null;
      await api(`/api/projects/${candidate.id}/approve`, { method: 'POST', body: { boardPath } });
      state.notice = `Approved ${candidate.name}.`;
      await refresh();
    } else if (target.dataset.rename) {
      const item = state.data.projects.find((candidate) => candidate.id === target.dataset.rename);
      const name = prompt('Project name', item.name);
      if (name) await api(`/api/projects/${item.id}`, { method: 'PATCH', body: { name } });
      await refresh();
    } else if (target.dataset.organize) {
      const item = state.data.projects.find((candidate) => candidate.id === target.dataset.organize);
      const organization = prompt('Organization', item.organization);
      if (organization !== null) await api(`/api/projects/${item.id}`, { method: 'PATCH', body: { organization } });
      await refresh();
    } else if (target.dataset.archive) { await api(`/api/projects/${target.dataset.archive}`, { method: 'PATCH', body: { state: 'archived' } }); await refresh(); }
    else if (target.dataset.restore) { await api(`/api/projects/${target.dataset.restore}`, { method: 'PATCH', body: { state: 'active' } }); await refresh(); }
    else if (target.dataset.transfer) {
      const destinationProjectId = document.querySelector('#transfer-destination').value;
      await api(`/api/projects/${target.dataset.project}/tickets/${target.dataset.transfer}/transfer`, { method: 'POST', body: { destinationProjectId } });
      closeModal();
      await refresh();
    }
  } catch (error) {
    state.notice = error.message;
    render();
  }
});

document.addEventListener('submit', async (event) => {
  try {
    if (event.target.id === 'create-project') {
      event.preventDefault();
      await api('/api/projects', { method: 'POST', body: Object.fromEntries(new FormData(event.target)) });
      state.notice = 'Created active project.';
      await refresh();
    } else if (event.target.id === 'discover-projects') {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      const result = await api('/api/projects/discover', { method: 'POST', body: form });
      state.notice = result.sourceFound ? `Found ${result.discovered.length} candidate(s).` : `No ${form.source} source found.`;
      await refresh();
    } else if (event.target.id === 'ticket-form') {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      const projectId = event.target.dataset.project;
      const ticketId = event.target.dataset.ticket;
      if (ticketId) await api(`/api/projects/${projectId}/tickets/${ticketId}`, { method: 'PATCH', body: form });
      else await api(`/api/projects/${projectId}/tickets`, { method: 'POST', body: { ...form, actor: 'captain-web' } });
      closeModal();
      await refresh();
    } else if (event.target.id === 'message-form') {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      await api(`/api/projects/${event.target.dataset.project}/tickets/${event.target.dataset.ticket}/messages`, { method: 'POST', body: form });
      await openTicket(event.target.dataset.project, event.target.dataset.ticket);
      await refresh();
    }
  } catch (error) {
    state.notice = error.message;
    render();
  }
});

document.querySelector('#modal-backdrop').addEventListener('click', (event) => {
  if (event.target.id === 'modal-backdrop') closeModal();
});

refresh();
setInterval(() => {
  const editing = document.activeElement?.matches('input,textarea,select');
  const modalOpen = document.querySelector('#modal-backdrop').classList.contains('open');
  if (!editing && !modalOpen) refresh();
}, 2500);
