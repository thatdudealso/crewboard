import http from 'node:http';
import path from 'node:path';
import { BoardStore, transferTicket } from './store.js';
import {
  approveWorkspaceProject,
  arrangeWorkspaceProject,
  createWorkspaceProject,
  discoverProjects,
  ensureWorkspace,
  getProjectRecord,
  listWorkspace,
  renameWorkspaceProject,
  updateWorkspaceProject,
} from './workspace.js';

const DEFAULT_PORT = 3737;

function send(response, status, body, contentType = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, `${JSON.stringify(body)}\n`, 'application/json; charset=utf-8');
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function pathParts(requestUrl) {
  return new URL(requestUrl, 'http://127.0.0.1').pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

async function boardForProject(workspaceFile, projectId) {
  const project = await getProjectRecord(workspaceFile, projectId);
  if (project.state !== 'active') throw new Error(`Project ${project.name} is not approved yet.`);
  if (!project.boardPath) throw new Error(`Project ${project.name} has no board path.`);
  return { project, board: await BoardStore.open(project.boardPath) };
}

function editableTicketChanges(body) {
  const changes = {};
  for (const key of ['title', 'body', 'status', 'assignee', 'priority']) {
    if (body[key] !== undefined) changes[key] = body[key];
  }
  if (body.labels !== undefined) changes.labels = Array.isArray(body.labels) ? body.labels : String(body.labels).split(',');
  if (body.links !== undefined) changes.links = Array.isArray(body.links) ? body.links : String(body.links).split(',');
  if (changes.assignee === '') changes.assignee = null;
  return changes;
}

async function snapshot(workspaceFile) {
  const listed = await listWorkspace(workspaceFile);
  return {
    workspace: listed.workspace,
    projects: listed.projects,
    pendingProjects: listed.pendingProjects,
    archivedProjects: listed.archivedProjects,
  };
}

async function api(request, response, workspaceFile) {
  const parts = pathParts(request.url);
  if (request.method === 'GET' && parts.join('/') === 'api/board') return sendJson(response, 200, await snapshot(workspaceFile));
  if (request.method === 'POST' && parts.join('/') === 'api/projects/discover') {
    const body = await readBody(request);
    return sendJson(response, 200, await discoverProjects(workspaceFile, body));
  }
  if (request.method === 'POST' && parts.join('/') === 'api/projects') {
    return sendJson(response, 201, await createWorkspaceProject(workspaceFile, await readBody(request)));
  }
  if (parts[0] !== 'api' || parts[1] !== 'projects' || !parts[2]) return sendJson(response, 404, { error: { message: 'Unknown API route.' } });
  const projectId = parts[2];
  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'approve') {
    return sendJson(response, 200, await approveWorkspaceProject(workspaceFile, projectId, await readBody(request)));
  }
  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'arrange') {
    const body = await readBody(request);
    return sendJson(response, 200, await arrangeWorkspaceProject(workspaceFile, projectId, body.direction));
  }
  if (request.method === 'PATCH' && parts.length === 3) {
    const body = await readBody(request);
    if (body.name !== undefined) return sendJson(response, 200, await renameWorkspaceProject(workspaceFile, projectId, body.name));
    return sendJson(response, 200, await updateWorkspaceProject(workspaceFile, projectId, body));
  }
  if (request.method === 'POST' && parts.length === 4 && parts[3] === 'tickets') {
    const body = await readBody(request);
    const { board } = await boardForProject(workspaceFile, projectId);
    return sendJson(response, 201, await board.createTicket({
      ...editableTicketChanges(body),
      actor: body.actor || 'captain-web',
    }));
  }
  if (parts[3] !== 'tickets' || !parts[4]) return sendJson(response, 404, { error: { message: 'Unknown project API route.' } });
  const ticketId = parts[4];
  const { board } = await boardForProject(workspaceFile, projectId);
  if (request.method === 'PATCH' && parts.length === 5) {
    const body = await readBody(request);
    return sendJson(response, 200, await board.updateTicket(ticketId, editableTicketChanges(body), {
      action: 'ticket-edited',
      actor: body.actor || 'captain-web',
      eventData: { fields: Object.keys(editableTicketChanges(body)) },
    }));
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'messages') {
    const body = await readBody(request);
    return sendJson(response, 201, await board.addComment(ticketId, {
      author: body.author || 'captain-web',
      body: body.body,
      mentions: body.mentions || [],
      replyTo: body.replyTo || null,
    }));
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'reorder') {
    const body = await readBody(request);
    return sendJson(response, 200, await board.reorderTickets(body.ticketIds, { status: body.status, actor: body.actor || 'captain-web' }));
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'transfer') {
    const body = await readBody(request);
    const destination = await boardForProject(workspaceFile, body.destinationProjectId);
    return sendJson(response, 200, await transferTicket(board, destination.board, ticketId, {
      destinationProjectId: destination.project.id,
      actor: body.actor || 'captain-web',
    }));
  }
  return sendJson(response, 404, { error: { message: 'Unknown ticket API route.' } });
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crewboard</title>
<style>
:root { color-scheme: dark; --bg:#0d0f12; --surface:#15181d; --surface-2:#1a1e24; --surface-3:#21262e; --line:#2a3039; --text:#edf0f2; --muted:#98a1ab; --quiet:#6f7884; --accent:#c2cad3; --shadow:0 1px 2px rgba(0,0,0,.06),0 10px 28px rgba(0,0,0,.06),0 24px 56px rgba(0,0,0,.06); --radius:14px; }
* { box-sizing:border-box; } body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
button,input,select,textarea { font:inherit; } button { cursor:pointer; } .app { min-height:100vh; display:grid; grid-template-columns:250px minmax(0,1fr); }
.sidebar { border-right:1px solid var(--line); padding:22px 14px; background:#101216; position:sticky; top:0; height:100vh; overflow:auto; } .brand { letter-spacing:.08em; font-weight:760; font-size:13px; text-transform:uppercase; display:flex; justify-content:space-between; align-items:center; padding:0 8px 22px; }
.live { color:var(--muted); font-size:10px; letter-spacing:.04em; } .nav-label { color:var(--quiet); letter-spacing:.09em; font-size:10px; font-weight:700; text-transform:uppercase; margin:18px 8px 7px; }
.nav-button,.project-button { border:0; color:var(--muted); background:transparent; width:100%; text-align:left; padding:9px 10px; border-radius:9px; display:flex; align-items:center; gap:9px; } .nav-button:hover,.project-button:hover,.nav-button.active,.project-button.active { color:var(--text); background:var(--surface-2); }
.origin { border:1px solid var(--line); color:var(--muted); border-radius:999px; padding:1px 6px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; } .main { min-width:0; padding:26px; }
.topbar { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:24px; } h1 { font-size:24px; line-height:1.15; margin:0 0 5px; letter-spacing:-.03em; } h2 { font-size:16px; margin:0; letter-spacing:-.01em; } p { color:var(--muted); margin:4px 0; } .actions { display:flex; gap:8px; flex-wrap:wrap; }
.button { border:1px solid var(--line); color:var(--text); background:var(--surface); border-radius:9px; padding:8px 11px; box-shadow:var(--shadow); } .button:hover { background:var(--surface-2); } .button.primary { background:var(--accent); color:#101216; border-color:var(--accent); font-weight:650; } .button.danger { color:#e5c2c2; }
.board { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(250px,1fr); gap:14px; overflow-x:auto; padding-bottom:14px; } .column { min-height:420px; border:1px solid var(--line); background:var(--surface); border-radius:var(--radius); padding:12px; box-shadow:var(--shadow); }
.column-heading { display:flex; align-items:center; justify-content:space-between; color:var(--muted); text-transform:uppercase; font-size:11px; letter-spacing:.08em; font-weight:700; padding:2px 2px 12px; } .count { background:var(--surface-3); border-radius:999px; min-width:22px; text-align:center; padding:1px 6px; color:var(--text); }
.ticket-list { min-height:340px; display:grid; align-content:start; gap:9px; } .ticket { border:1px solid var(--line); background:var(--surface-2); border-radius:11px; padding:11px; box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 18px rgba(0,0,0,.06); } .ticket:hover { border-color:#404853; } .ticket.dragging { opacity:.45; }
.ticket-meta,.small { color:var(--muted); font-size:11px; } .ticket-title { margin:6px 0 8px; font-weight:650; line-height:1.3; } .ticket-footer { display:flex; justify-content:space-between; gap:8px; align-items:center; } .chip { color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:2px 6px; font-size:10px; }
.panel { border:1px solid var(--line); border-radius:var(--radius); padding:17px; background:var(--surface); box-shadow:var(--shadow); margin-bottom:16px; } .panel-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; } .project-card { border:1px solid var(--line); border-radius:11px; padding:14px; background:var(--surface-2); }
.form-row { display:grid; gap:5px; margin:10px 0; } label { color:var(--muted); font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; } input,select,textarea { color:var(--text); background:#111419; border:1px solid var(--line); border-radius:8px; padding:8px 9px; width:100%; } textarea { min-height:110px; resize:vertical; }
.message { border-left:2px solid var(--line); padding:10px 12px; background:var(--surface-2); border-radius:0 9px 9px 0; margin:8px 0; } .message p { color:var(--text); white-space:pre-wrap; } .empty { color:var(--muted); border:1px dashed var(--line); border-radius:11px; padding:28px; text-align:center; }
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.58); display:none; align-items:center; justify-content:center; padding:18px; } .modal-backdrop.open { display:flex; } .modal { width:min(760px,100%); max-height:92vh; overflow:auto; border:1px solid var(--line); background:var(--surface); border-radius:16px; padding:20px; box-shadow:0 1px 2px rgba(0,0,0,.06),0 24px 70px rgba(0,0,0,.06); }
.modal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; } .two-col { display:grid; grid-template-columns:1fr 1fr; gap:12px; } .notice { color:var(--muted); font-size:12px; margin:8px 0; } .hidden { display:none; }
@media (max-width:800px) { .app { grid-template-columns:1fr; } .sidebar { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); } .main { padding:18px; } .two-col { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="app"><aside class="sidebar"><div class="brand">Crewboard <span class="live">LIVE</span></div><div class="nav-label">Views</div><button class="nav-button active" data-view="board">Board</button><button class="nav-button" data-view="messages">Message board</button><button class="nav-button" data-view="projects">Projects</button><div class="nav-label">Active projects</div><div id="project-nav"></div><div class="nav-label">Pending approval</div><div id="pending-nav"></div></aside><main class="main"><div id="app"></div></main></div>
<div class="modal-backdrop" id="modal-backdrop"><section class="modal" id="modal"></section></div>
<script>
const state={data:null,view:'board',projectId:null,notice:''};
const escapeHtml=(value)=>String(value??'').replace(/[&<>'"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const api=async (url,options={})=>{const response=await fetch(url,{headers:{'content-type':'application/json'},...options,body:options.body?JSON.stringify(options.body):undefined});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Request failed.');return data;};
const project=()=>state.data?.projects.find((item)=>item.id===state.projectId)||state.data?.projects[0];
const allMessages=()=>{const item=project();return item?(item.tickets||[]).flatMap((ticket)=>ticket.messages.map((message)=>({...message,ticket}))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)):[];};
async function refresh(){try{state.data=await api('/api/board');if(!state.projectId&&state.data.projects.length)state.projectId=state.data.projects[0].id;render();}catch(error){state.notice=error.message;render();}}
function renderNavigation(){const active=state.data?.projects||[];const pending=state.data?.pendingProjects||[];document.querySelector('#project-nav').innerHTML=active.map((item)=>'<button class="project-button '+(project()?.id===item.id?'active':'')+'" data-project="'+item.id+'"><span class="origin">'+escapeHtml(item.origin)+'</span><span>'+escapeHtml(item.name)+'</span></button>').join('')||'<p class="small">No approved projects</p>';document.querySelector('#pending-nav').innerHTML=pending.map((item)=>'<button class="project-button" data-view="projects"><span class="origin">'+escapeHtml(item.origin)+'</span><span>'+escapeHtml(item.name)+'</span></button>').join('')||'<p class="small">Nothing waiting</p>';document.querySelectorAll('[data-view]').forEach((button)=>button.classList.toggle('active',button.dataset.view===state.view));}
function ticketCard(item,ticket){return '<article class="ticket" draggable="true" data-ticket="'+ticket.id+'" data-project="'+item.id+'"><div class="ticket-meta">'+ticket.id+' · '+escapeHtml(ticket.priority)+'</div><div class="ticket-title">'+escapeHtml(ticket.title)+'</div><div class="ticket-footer"><span class="chip">'+escapeHtml(ticket.assignee?'@'+ticket.assignee:'unassigned')+'</span><span class="small">'+ticket.messages.length+' msg</span></div></article>';}
function boardForProject(item){if(!item.available)return '<section class="empty">'+escapeHtml(item.error||'This project board is unavailable.')+'</section>';return '<section class="panel"><div class="topbar"><div><h2>'+escapeHtml(item.name)+'</h2><p>'+escapeHtml(item.organization)+' · <span class="origin">'+escapeHtml(item.origin)+'</span></p></div></div><div class="board">'+item.columns.map((status)=>{const tickets=item.tickets.filter((ticket)=>ticket.status===status);return '<section class="column" data-column="'+status+'" data-project="'+item.id+'"><div class="column-heading"><span>'+escapeHtml(status)+'</span><span class="count">'+tickets.length+'</span></div><div class="ticket-list">'+tickets.map((ticket)=>ticketCard(item,ticket)).join('')+'</div></section>';}).join('')+'</div></section>';}
function renderBoard(){const selected=project();if(!selected)return '<section class="empty"><h2>Your fleet is ready for its first project</h2><p>Open Projects to create a board or scan sources. Discovered projects always wait for captain approval.</p></section>';return boardForProject(selected);}
function renderMessages(){const messages=allMessages();return '<section class="panel"><h2>Message board</h2><p>Threaded work context across the selected project.</p></section>'+ (messages.length?messages.map((message)=>'<section class="message"><div class="small">'+escapeHtml(message.ticket.id)+' · @'+escapeHtml(message.author)+' · '+new Date(message.createdAt).toLocaleString()+'</div><p>'+escapeHtml(message.body)+'</p></section>').join(''):'<section class="empty">No messages in this project yet.</section>');}
function pendingCard(item){return '<article class="project-card"><div class="small"><span class="origin">'+escapeHtml(item.origin)+'</span> Pending approval</div><h2>'+escapeHtml(item.name)+'</h2><p>'+escapeHtml(item.path||item.sourceLocation||'No local board path supplied')+'</p><button class="button primary" data-approve="'+item.id+'">Approve project</button></article>';}
function renderProjects(){const pending=state.data?.pendingProjects||[];const archived=state.data?.archivedProjects||[];const active=state.data?.projects||[];return '<section class="panel"><h2>Captain controls</h2><p>Create, import, approve, organize, and archive projects. Imports never activate on their own.</p><div class="panel-grid"><form id="create-project" class="project-card"><h2>Create project</h2><div class="form-row"><label>Name</label><input name="name" required placeholder="Project name"></div><div class="form-row"><label>Local board path</label><input name="boardPath" required placeholder="/path/to/project"></div><div class="form-row"><label>Organization</label><input name="organization" value="Unsorted"></div><button class="button primary">Create active project</button></form><form id="discover-projects" class="project-card"><h2>Discover import candidates</h2><div class="form-row"><label>Source</label><select name="source"><option value="local">Local git repositories</option><option value="claude">Claude projects</option><option value="chatgpt">ChatGPT export</option></select></div><div class="form-row"><label>Root or export file</label><input name="root" placeholder="~/src or /path/to/export.json"></div><button class="button">Scan for approval</button><p class="notice">A missing ChatGPT export reports a no-source state. Nothing is invented.</p></form></div><p class="notice">'+escapeHtml(state.notice||'')+'</p></section><section class="panel"><h2>Pending approval</h2><div class="panel-grid">'+(pending.map(pendingCard).join('')||'<p class="empty">No candidates waiting for approval.</p>')+'</div></section><section class="panel"><h2>Active projects</h2><div class="panel-grid">'+active.map((item)=>'<article class="project-card"><div class="small"><span class="origin">'+escapeHtml(item.origin)+'</span> '+escapeHtml(item.organization)+'</div><h2>'+escapeHtml(item.name)+'</h2><p>'+escapeHtml(item.boardPath||'')+'</p><div class="actions"><button class="button" data-rename="'+item.id+'">Rename</button><button class="button" data-organize="'+item.id+'">Organize</button><button class="button" data-arrange="up:'+item.id+'">↑</button><button class="button" data-arrange="down:'+item.id+'">↓</button><button class="button danger" data-archive="'+item.id+'">Archive</button></div></article>').join('')+'</div></section>'+(archived.length?'<section class="panel"><h2>Archived</h2><div class="panel-grid">'+archived.map((item)=>'<article class="project-card"><h2>'+escapeHtml(item.name)+'</h2><button class="button" data-restore="'+item.id+'">Restore</button></article>').join('')+'</div></section>':'');}
function render(){renderNavigation();const selected=project();const subtitle=state.view==='board'?(selected?selected.name+' · live ticket state':'Fleet overview'):state.view==='messages'?'Threaded coordination, kept with the work':'Approval and organization';let content=state.view==='board'?renderBoard():state.view==='messages'?renderMessages():renderProjects();document.querySelector('#app').innerHTML='<div class="topbar"><div><h1>'+escapeHtml(state.view==='board'?'Board':state.view==='messages'?'Message board':'Projects')+'</h1><p>'+escapeHtml(subtitle)+'</p></div><div class="actions">'+(selected&&state.view!=='projects'?'<button class="button" data-open-new-ticket="true">New ticket</button>':'')+'<button class="button" data-refresh="true">Refresh</button></div></div>'+content;bindBoard();}
function bindBoard(){document.querySelectorAll('.ticket').forEach((card)=>{card.addEventListener('dragstart',(event)=>{card.classList.add('dragging');event.dataTransfer.setData('text/plain',JSON.stringify({ticketId:card.dataset.ticket,projectId:card.dataset.project}));});card.addEventListener('dragend',()=>card.classList.remove('dragging'));card.addEventListener('click',()=>openTicket(card.dataset.project,card.dataset.ticket));});document.querySelectorAll('.ticket-list').forEach((list)=>list.addEventListener('dragover',(event)=>event.preventDefault()));document.querySelectorAll('.column').forEach((column)=>column.addEventListener('drop',async(event)=>{event.preventDefault();const payload=JSON.parse(event.dataTransfer.getData('text/plain'));if(payload.projectId!==column.dataset.project)return;column.querySelector('.ticket-list').append(document.querySelector('[data-ticket="'+payload.ticketId+'"][data-project="'+payload.projectId+'"]'));const ticketIds=[...column.querySelectorAll('.ticket')].map((card)=>card.dataset.ticket);try{await api('/api/projects/'+column.dataset.project+'/tickets/'+payload.ticketId+'/reorder',{method:'POST',body:{ticketIds,status:column.dataset.column}});await refresh();}catch(error){state.notice=error.message;render();}}));}
function openModal(content){document.querySelector('#modal').innerHTML=content;document.querySelector('#modal-backdrop').classList.add('open');}function closeModal(){document.querySelector('#modal-backdrop').classList.remove('open');}
document.addEventListener('click',async(event)=>{const target=event.target.closest('button[data-transfer]');if(!target)return;event.stopImmediatePropagation();try{const destinationProjectId=document.querySelector('#transfer-destination').value;await api('/api/projects/'+target.dataset.project+'/tickets/'+target.dataset.transfer+'/transfer',{method:'POST',body:{destinationProjectId}});closeModal();await refresh();}catch(error){state.notice=error.message;render();}},true);
function openTicket(projectId,ticketId){const item=state.data.projects.find((candidate)=>candidate.id===projectId);const ticket=item.tickets.find((candidate)=>candidate.id===ticketId);const destinations=state.data.projects.filter((candidate)=>candidate.id!==projectId).map((candidate)=>'<option value="'+candidate.id+'">'+escapeHtml(candidate.name)+'</option>').join('');openModal('<div class="modal-head"><div><h2>'+escapeHtml(ticket.id)+'</h2><p>Edit the ticket through the shared store.</p></div><button class="button" data-close-modal="true">Close</button></div><form id="ticket-form" data-project="'+projectId+'" data-ticket="'+ticketId+'"><div class="form-row"><label>Title</label><input name="title" value="'+escapeHtml(ticket.title)+'"></div><div class="two-col"><div class="form-row"><label>Status</label><select name="status">'+item.columns.map((status)=>'<option '+(status===ticket.status?'selected':'')+'>'+escapeHtml(status)+'</option>').join('')+'</select></div><div class="form-row"><label>Assignee</label><input name="assignee" value="'+escapeHtml(ticket.assignee||'')+'"></div></div><div class="two-col"><div class="form-row"><label>Priority</label><input name="priority" value="'+escapeHtml(ticket.priority)+'"></div><div class="form-row"><label>Labels</label><input name="labels" value="'+escapeHtml(ticket.labels.join(', '))+'"></div></div><div class="form-row"><label>Links</label><input name="links" value="'+escapeHtml(ticket.links.join(', '))+'"></div><div class="form-row"><label>Context and acceptance criteria</label><textarea name="body">'+escapeHtml(ticket.body)+'</textarea></div><div class="actions"><button class="button primary">Save ticket</button>'+ (destinations?'<select id="transfer-destination">'+destinations+'</select><button class="button" type="button" data-transfer="'+ticketId+'" data-project="'+projectId+'">Move to project</button>':'')+'</div></form><section class="panel"><h2>Thread</h2>'+ticket.messages.map((message)=>'<div class="message"><div class="small">@'+escapeHtml(message.author)+' · '+new Date(message.createdAt).toLocaleString()+'</div><p>'+escapeHtml(message.body)+'</p></div>').join('')+'<form id="message-form" data-project="'+projectId+'" data-ticket="'+ticketId+'"><div class="form-row"><label>Captain message</label><textarea name="body" required placeholder="Write a durable handoff, decision, or question."></textarea></div><button class="button">Post message</button></form></section>');}
document.addEventListener('click',async(event)=>{const target=event.target.closest('button');if(!target)return;try{if(target.dataset.view){state.view=target.dataset.view;render();}else if(target.dataset.project){state.projectId=target.dataset.project;state.view='board';render();}else if(target.dataset.refresh){await refresh();}else if(target.dataset.closeModal){closeModal();}else if(target.dataset.openNewTicket){const item=project();openModal('<div class="modal-head"><h2>New ticket</h2><button class="button" data-close-modal="true">Close</button></div><form id="ticket-form" data-project="'+item.id+'"><div class="form-row"><label>Title</label><input name="title" required></div><div class="form-row"><label>Context and acceptance criteria</label><textarea name="body"></textarea></div><div class="form-row"><label>Status</label><select name="status">'+item.columns.map((status)=>'<option>'+escapeHtml(status)+'</option>').join('')+'</select></div><button class="button primary">Create ticket</button></form>');}else if(target.dataset.approve){const candidate=state.data.pendingProjects.find((item)=>item.id===target.dataset.approve);const boardPath=candidate.boardPath||prompt('Local board path for '+candidate.name+':','')||null;await api('/api/projects/'+candidate.id+'/approve',{method:'POST',body:{boardPath}});state.notice='Approved '+candidate.name+'.';await refresh();}else if(target.dataset.rename){const item=state.data.projects.find((candidate)=>candidate.id===target.dataset.rename);const name=prompt('Project name',item.name);if(name)await api('/api/projects/'+item.id,{method:'PATCH',body:{name}});await refresh();}else if(target.dataset.organize){const item=state.data.projects.find((candidate)=>candidate.id===target.dataset.organize);const organization=prompt('Organization',item.organization);if(organization!==null)await api('/api/projects/'+item.id,{method:'PATCH',body:{organization}});await refresh();}else if(target.dataset.archive){await api('/api/projects/'+target.dataset.archive,{method:'PATCH',body:{state:'archived'}});await refresh();}else if(target.dataset.restore){await api('/api/projects/'+target.dataset.restore,{method:'PATCH',body:{state:'active'}});await refresh();}else if(target.dataset.arrange){const [direction,id]=target.dataset.arrange.split(':');await api('/api/projects/'+id+'/arrange',{method:'POST',body:{direction}});await refresh();}else if(target.dataset.transfer){const destinationProjectId=document.querySelector('#transfer-destination').value;await api('/api/projects/'+target.dataset.project+'/tickets/'+target.dataset.transfer+'/transfer',{method:'POST',body:{destinationProjectId}});closeModal();await refresh();}}catch(error){state.notice=error.message;render();}});
document.addEventListener('submit',async(event)=>{try{if(event.target.id==='create-project'){event.preventDefault();const form=new FormData(event.target);await api('/api/projects',{method:'POST',body:Object.fromEntries(form)});state.notice='Created active project.';await refresh();}else if(event.target.id==='discover-projects'){event.preventDefault();const form=Object.fromEntries(new FormData(event.target));const result=await api('/api/projects/discover',{method:'POST',body:form});state.notice=result.sourceFound?'Found '+result.discovered.length+' candidate(s) awaiting approval.':'No '+form.source+' source found. Nothing was imported.';await refresh();}else if(event.target.id==='ticket-form'){event.preventDefault();const form=Object.fromEntries(new FormData(event.target));const projectId=event.target.dataset.project;const ticketId=event.target.dataset.ticket;if(ticketId)await api('/api/projects/'+projectId+'/tickets/'+ticketId,{method:'PATCH',body:form});else await api('/api/projects/'+projectId+'/tickets',{method:'POST',body:form});closeModal();await refresh();}else if(event.target.id==='message-form'){event.preventDefault();const form=Object.fromEntries(new FormData(event.target));await api('/api/projects/'+event.target.dataset.project+'/tickets/'+event.target.dataset.ticket+'/messages',{method:'POST',body:form});closeModal();await refresh();}}catch(error){state.notice=error.message;render();}});
document.querySelector('#modal-backdrop').addEventListener('click',(event)=>{if(event.target.id==='modal-backdrop')closeModal();});
refresh();setInterval(()=>{const editing=document.activeElement?.matches('input,textarea,select');const modalOpen=document.querySelector('#modal-backdrop').classList.contains('open');if(!editing&&!modalOpen)refresh();},2000);
</script></body></html>`;
}

export async function startWebServer({ cwd = process.cwd(), workspaceFile = 'crewboard-workspace.json', port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const resolvedWorkspace = path.resolve(cwd, workspaceFile);
  await ensureWorkspace(resolvedWorkspace);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/' && request.method === 'GET') return send(response, 200, page());
      if (request.url.startsWith('/api/')) return await api(request, response, resolvedWorkspace);
      return send(response, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (error) {
      return sendJson(response, 400, { error: { message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), host, resolve);
  });
  const address = server.address();
  return { server, workspaceFile: resolvedWorkspace, url: `http://${host}:${address.port}` };
}
