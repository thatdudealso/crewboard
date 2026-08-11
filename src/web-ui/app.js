const state = { data: null, view: 'board', projectId: null, notice: '' };

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

const titleAttr = (value) => 'title="' + escapeHtml(value) + '"';

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
const allMessages = () => {
  const item = project();
  return item
    ? (item.tickets || []).flatMap((ticket) => ticket.messages.map((message) => ({ ...message, ticket }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
};

async function refresh() {
  try {
    state.data = await api('/api/board');
    if (!state.projectId && state.data.projects.length) state.projectId = state.data.projects[0].id;
    render();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}

function setHtml(selector, html) {
  const node = document.querySelector(selector);
  if (node) node.replaceChildren();
  if (node) node.insertAdjacentHTML('afterbegin', html);
}

function renderNavigation() {
  const active = state.data?.projects || [];
  const pending = state.data?.pendingProjects || [];
  setHtml('#project-nav', active.map((item) => (
    '<button class="project-button ' + (project()?.id === item.id ? 'active' : '') + '" data-project="' + escapeHtml(item.id) + '">'
    + '<span class="origin">' + escapeHtml(item.origin) + '</span>'
    + '<span class="nav-text" ' + titleAttr(item.name) + '>' + escapeHtml(item.name) + '</span></button>'
  )).join('') || '<p class="small">No approved projects</p>');
  setHtml('#pending-nav', pending.map((item) => (
    '<button class="project-button" data-view="projects">'
    + '<span class="origin">' + escapeHtml(item.origin) + '</span>'
    + '<span class="nav-text" ' + titleAttr(item.name) + '>' + escapeHtml(item.name) + '</span></button>'
  )).join('') || '<p class="small">Nothing waiting</p>');
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
}

function ticketBodyPreview(ticket) {
  const body = String(ticket.body || '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  // Keep cards scannable: skip short import stubs; clamp everything else to one line.
  if (/^imported from\b/i.test(body) && body.length < 80) return '';
  return '<div class="ticket-body" ' + titleAttr(body) + '>' + escapeHtml(body) + '</div>';
}

function ticketCard(item, ticket) {
  const assignee = ticket.assignee ? '@' + ticket.assignee : 'unassigned';
  return '<article class="ticket" draggable="true" data-ticket="' + escapeHtml(ticket.id) + '" data-project="' + escapeHtml(item.id) + '">'
    + '<div class="ticket-meta"><span class="ticket-id" ' + titleAttr(ticket.id) + '>' + escapeHtml(ticket.id) + '</span>'
    + '<span class="ticket-priority" ' + titleAttr(ticket.priority) + '>' + escapeHtml(ticket.priority) + '</span></div>'
    + '<div class="ticket-title" ' + titleAttr(ticket.title) + '>' + escapeHtml(ticket.title) + '</div>'
    + ticketBodyPreview(ticket)
    + '<div class="ticket-footer"><span class="chip" ' + titleAttr(assignee) + '>' + escapeHtml(assignee) + '</span>'
    + '<span class="small">' + ticket.messages.length + ' msg</span></div></article>';
}

function boardForProject(item) {
  if (!item.available) return '<section class="empty">' + escapeHtml(item.error || 'This project board is unavailable.') + '</section>';
  return '<section class="panel board-panel"><div class="topbar"><div>'
    + '<h2 ' + titleAttr(item.name) + '>' + escapeHtml(item.name) + '</h2>'
    + '<p>' + escapeHtml(item.organization) + ' · <span class="origin">' + escapeHtml(item.origin) + '</span></p></div></div>'
    + '<div class="board">' + item.columns.map((status) => {
      const tickets = item.tickets.filter((ticket) => ticket.status === status);
      return '<section class="column" data-column="' + escapeHtml(status) + '" data-project="' + escapeHtml(item.id) + '">'
        + '<div class="column-heading"><span>' + escapeHtml(status) + '</span><span class="count">' + tickets.length + '</span></div>'
        + '<div class="ticket-list">' + tickets.map((ticket) => ticketCard(item, ticket)).join('') + '</div></section>';
    }).join('') + '</div></section>';
}

function renderBoard() {
  const selected = project();
  if (!selected) return '<section class="empty"><h2>Your fleet is ready for its first project</h2><p>Open Projects to create a board or scan sources. Discovered projects always wait for captain approval.</p></section>';
  return boardForProject(selected);
}

function renderMessages() {
  const messages = allMessages();
  return '<section class="panel"><h2>Message board</h2><p>Threaded work context across the selected project.</p></section>'
    + '<div class="message-board">' + (messages.length ? messages.map((message) => {
      const meta = message.ticket.id + ' · @' + message.author + ' · ' + new Date(message.createdAt).toLocaleString();
      return '<section class="message"><div class="small" ' + titleAttr(meta) + '>' + escapeHtml(meta) + '</div><p>' + escapeHtml(message.body) + '</p></section>';
    }).join('') : '<section class="empty">No messages in this project yet.</section>') + '</div>';
}

function pendingCard(item) {
  const pathLabel = item.path || item.sourceLocation || 'No local board path supplied';
  return '<article class="project-card"><div class="small"><span class="origin">' + escapeHtml(item.origin) + '</span> Pending approval</div>'
    + '<h2 ' + titleAttr(item.name) + '>' + escapeHtml(item.name) + '</h2>'
    + '<p ' + titleAttr(pathLabel) + '>' + escapeHtml(pathLabel) + '</p>'
    + '<button class="button primary" data-approve="' + escapeHtml(item.id) + '">Approve project</button></article>';
}

function renderProjects() {
  const pending = state.data?.pendingProjects || [];
  const archived = state.data?.archivedProjects || [];
  const active = state.data?.projects || [];
  return '<div class="view-scroll"><section class="panel"><h2>Captain controls</h2>'
    + '<p>Create, import, approve, organize, and archive projects. Imports never activate on their own.</p>'
    + '<div class="panel-grid"><form id="create-project" class="project-card"><h2>Create project</h2>'
    + '<div class="form-row"><label>Name</label><input name="name" required placeholder="Project name"></div>'
    + '<div class="form-row"><label>Local board path</label><input name="boardPath" required placeholder="/path/to/project"></div>'
    + '<div class="form-row"><label>Organization</label><input name="organization" value="Unsorted"></div>'
    + '<button class="button primary">Create active project</button></form>'
    + '<form id="discover-projects" class="project-card"><h2>Discover import candidates</h2>'
    + '<div class="form-row"><label>Source</label><select name="source"><option value="local">Local git repositories</option><option value="claude">Claude projects</option><option value="chatgpt">ChatGPT export</option></select></div>'
    + '<div class="form-row"><label>Root or export file</label><input name="root" placeholder="~/src or /path/to/export.json"></div>'
    + '<button class="button">Scan for approval</button><p class="notice">A missing ChatGPT export reports a no-source state. Nothing is invented.</p></form></div>'
    + '<p class="notice">' + escapeHtml(state.notice || '') + '</p></section>'
    + '<section class="panel"><h2>Pending approval</h2><div class="panel-grid">' + (pending.map(pendingCard).join('') || '<p class="empty">No candidates waiting for approval.</p>') + '</div></section>'
    + '<section class="panel"><h2>Active projects</h2><div class="panel-grid">' + active.map((item) => (
      '<article class="project-card"><div class="small"><span class="origin">' + escapeHtml(item.origin) + '</span> ' + escapeHtml(item.organization) + '</div>'
      + '<h2 ' + titleAttr(item.name) + '>' + escapeHtml(item.name) + '</h2>'
      + '<p ' + titleAttr(item.boardPath || '') + '>' + escapeHtml(item.boardPath || '') + '</p>'
      + '<div class="actions"><button class="button" data-rename="' + escapeHtml(item.id) + '">Rename</button>'
      + '<button class="button" data-organize="' + escapeHtml(item.id) + '">Organize</button>'
      + '<button class="button" data-arrange="' + escapeHtml('up:' + item.id) + '">↑</button>'
      + '<button class="button" data-arrange="' + escapeHtml('down:' + item.id) + '">↓</button>'
      + '<button class="button danger" data-archive="' + escapeHtml(item.id) + '">Archive</button></div></article>'
    )).join('') + '</div></section>'
    + (archived.length ? '<section class="panel"><h2>Archived</h2><div class="panel-grid">' + archived.map((item) => (
      '<article class="project-card"><h2 ' + titleAttr(item.name) + '>' + escapeHtml(item.name) + '</h2>'
      + '<button class="button" data-restore="' + escapeHtml(item.id) + '">Restore</button></article>'
    )).join('') + '</div></section>' : '') + '</div>';
}

function render() {
  renderNavigation();
  const selected = project();
  const subtitle = state.view === 'board'
    ? (selected ? selected.name + ' · live ticket state' : 'Fleet overview')
    : state.view === 'messages' ? 'Threaded coordination, kept with the work' : 'Approval and organization';
  const content = state.view === 'board' ? renderBoard() : state.view === 'messages' ? renderMessages() : renderProjects();
  setHtml('#app', '<div class="topbar"><div><h1>' + escapeHtml(state.view === 'board' ? 'Board' : state.view === 'messages' ? 'Message board' : 'Projects') + '</h1>'
    + '<p ' + titleAttr(subtitle) + '>' + escapeHtml(subtitle) + '</p></div><div class="actions">'
    + (selected && state.view !== 'projects' ? '<button class="button" data-open-new-ticket="true">New ticket</button>' : '')
    + '<button class="button" data-refresh="true">Refresh</button></div></div>' + content);
  bindBoard();
}

function bindBoard() {
  document.querySelectorAll('.ticket').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      card.classList.add('dragging');
      event.dataTransfer.setData('text/plain', JSON.stringify({ ticketId: card.dataset.ticket, projectId: card.dataset.project }));
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => openTicket(card.dataset.project, card.dataset.ticket));
  });
  document.querySelectorAll('.ticket-list').forEach((list) => list.addEventListener('dragover', (event) => event.preventDefault()));
  document.querySelectorAll('.column').forEach((column) => column.addEventListener('drop', async (event) => {
    event.preventDefault();
    const payload = JSON.parse(event.dataTransfer.getData('text/plain'));
    if (payload.projectId !== column.dataset.project) return;
    const list = column.querySelector('.ticket-list');
    const dragged = document.querySelector('.ticket.dragging');
    const before = [...list.querySelectorAll('.ticket:not(.dragging)')].find((card) => event.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    list.insertBefore(dragged, before || null);
    const ticketIds = [...list.querySelectorAll('.ticket')].map((card) => card.dataset.ticket);
    try {
      await api('/api/projects/' + column.dataset.project + '/tickets/' + payload.ticketId + '/reorder', { method: 'POST', body: { ticketIds, status: column.dataset.column } });
      await refresh();
    } catch (error) {
      state.notice = error.message;
      render();
    }
  }));
}

function openModal(content) {
  setHtml('#modal', content);
  document.querySelector('#modal-backdrop').classList.add('open');
}
function closeModal() { document.querySelector('#modal-backdrop').classList.remove('open'); }

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button[data-transfer]');
  if (!target) return;
  event.stopImmediatePropagation();
  try {
    const destinationProjectId = document.querySelector('#transfer-destination').value;
    await api('/api/projects/' + target.dataset.project + '/tickets/' + target.dataset.transfer + '/transfer', { method: 'POST', body: { destinationProjectId } });
    closeModal();
    await refresh();
  } catch (error) {
    state.notice = error.message;
    render();
  }
}, true);

function openTicket(projectId, ticketId) {
  const item = state.data.projects.find((candidate) => candidate.id === projectId);
  const ticket = item.tickets.find((candidate) => candidate.id === ticketId);
  const destinations = state.data.projects.filter((candidate) => candidate.id !== projectId).map((candidate) => '<option value="' + escapeHtml(candidate.id) + '">' + escapeHtml(candidate.name) + '</option>').join('');
  openModal('<div class="modal-head"><div><h2 ' + titleAttr(ticket.id) + '>' + escapeHtml(ticket.id) + '</h2><p>Edit the ticket through the shared store.</p></div><button class="button" data-close-modal="true">Close</button></div>'
    + '<form id="ticket-form" data-project="' + escapeHtml(projectId) + '" data-ticket="' + escapeHtml(ticketId) + '">'
    + '<div class="form-row"><label>Title</label><input name="title" value="' + escapeHtml(ticket.title) + '"></div>'
    + '<div class="two-col"><div class="form-row"><label>Status</label><select name="status">' + item.columns.map((status) => '<option ' + (status === ticket.status ? 'selected' : '') + '>' + escapeHtml(status) + '</option>').join('') + '</select></div>'
    + '<div class="form-row"><label>Assignee</label><input name="assignee" value="' + escapeHtml(ticket.assignee || '') + '"></div></div>'
    + '<div class="two-col"><div class="form-row"><label>Priority</label><input name="priority" value="' + escapeHtml(ticket.priority) + '"></div>'
    + '<div class="form-row"><label>Labels</label><input name="labels" value="' + escapeHtml(ticket.labels.join(', ')) + '"></div></div>'
    + '<div class="form-row"><label>Links</label><input name="links" value="' + escapeHtml(ticket.links.join(', ')) + '"></div>'
    + '<div class="form-row"><label>Context and acceptance criteria</label><textarea name="body">' + escapeHtml(ticket.body) + '</textarea></div>'
    + '<div class="actions"><button class="button primary">Save ticket</button>'
    + (destinations ? '<select id="transfer-destination">' + destinations + '</select><button class="button" type="button" data-transfer="' + escapeHtml(ticketId) + '" data-project="' + escapeHtml(projectId) + '">Move to project</button>' : '')
    + '</div></form><section class="panel"><h2>Thread</h2>'
    + ticket.messages.map((message) => '<div class="message"><div class="small">@' + escapeHtml(message.author) + ' · ' + new Date(message.createdAt).toLocaleString() + '</div><p>' + escapeHtml(message.body) + '</p></div>').join('')
    + '<form id="message-form" data-project="' + escapeHtml(projectId) + '" data-ticket="' + escapeHtml(ticketId) + '"><div class="form-row"><label>Captain message</label><textarea name="body" required placeholder="Write a durable handoff, decision, or question."></textarea></div><button class="button">Post message</button></form></section>');
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.view) { state.view = target.dataset.view; render(); }
    else if (target.dataset.project) { state.projectId = target.dataset.project; state.view = 'board'; render(); }
    else if (target.dataset.refresh) { await refresh(); }
    else if (target.dataset.closeModal) { closeModal(); }
    else if (target.dataset.openNewTicket) {
      const item = project();
      openModal('<div class="modal-head"><h2>New ticket</h2><button class="button" data-close-modal="true">Close</button></div><form id="ticket-form" data-project="' + escapeHtml(item.id) + '"><div class="form-row"><label>Title</label><input name="title" required></div><div class="form-row"><label>Context and acceptance criteria</label><textarea name="body"></textarea></div><div class="form-row"><label>Status</label><select name="status">' + item.columns.map((status) => '<option>' + escapeHtml(status) + '</option>').join('') + '</select></div><button class="button primary">Create ticket</button></form>');
    } else if (target.dataset.approve) {
      const candidate = state.data.pendingProjects.find((item) => item.id === target.dataset.approve);
      const boardPath = candidate.boardPath || prompt('Local board path for ' + candidate.name + ':', '') || null;
      await api('/api/projects/' + candidate.id + '/approve', { method: 'POST', body: { boardPath } });
      state.notice = 'Approved ' + candidate.name + '.';
      await refresh();
    } else if (target.dataset.rename) {
      const item = state.data.projects.find((candidate) => candidate.id === target.dataset.rename);
      const name = prompt('Project name', item.name);
      if (name) await api('/api/projects/' + item.id, { method: 'PATCH', body: { name } });
      await refresh();
    } else if (target.dataset.organize) {
      const item = state.data.projects.find((candidate) => candidate.id === target.dataset.organize);
      const organization = prompt('Organization', item.organization);
      if (organization !== null) await api('/api/projects/' + item.id, { method: 'PATCH', body: { organization } });
      await refresh();
    } else if (target.dataset.archive) {
      await api('/api/projects/' + target.dataset.archive, { method: 'PATCH', body: { state: 'archived' } });
      await refresh();
    } else if (target.dataset.restore) {
      await api('/api/projects/' + target.dataset.restore, { method: 'PATCH', body: { state: 'active' } });
      await refresh();
    } else if (target.dataset.arrange) {
      const [direction, id] = target.dataset.arrange.split(':');
      await api('/api/projects/' + id + '/arrange', { method: 'POST', body: { direction } });
      await refresh();
    } else if (target.dataset.transfer) {
      const destinationProjectId = document.querySelector('#transfer-destination').value;
      await api('/api/projects/' + target.dataset.project + '/tickets/' + target.dataset.transfer + '/transfer', { method: 'POST', body: { destinationProjectId } });
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
      const form = new FormData(event.target);
      await api('/api/projects', { method: 'POST', body: Object.fromEntries(form) });
      state.notice = 'Created active project.';
      await refresh();
    } else if (event.target.id === 'discover-projects') {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      const result = await api('/api/projects/discover', { method: 'POST', body: form });
      state.notice = result.sourceFound ? 'Found ' + result.discovered.length + ' candidate(s) awaiting approval.' : 'No ' + form.source + ' source found. Nothing was imported.';
      await refresh();
    } else if (event.target.id === 'ticket-form') {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      const projectId = event.target.dataset.project;
      const ticketId = event.target.dataset.ticket;
      if (ticketId) await api('/api/projects/' + projectId + '/tickets/' + ticketId, { method: 'PATCH', body: form });
      else await api('/api/projects/' + projectId + '/tickets', { method: 'POST', body: form });
      closeModal();
      await refresh();
    } else if (event.target.id === 'message-form') {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.target));
      await api('/api/projects/' + event.target.dataset.project + '/tickets/' + event.target.dataset.ticket + '/messages', { method: 'POST', body: form });
      closeModal();
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
}, 2000);
