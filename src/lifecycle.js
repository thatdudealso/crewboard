import { BoardStore } from './store.js';

export async function createTicket(root, attributes) {
  const board = await BoardStore.open(root);
  return board.createTicket(attributes);
}

export async function moveTicket(root, id, status, options) {
  const board = await BoardStore.open(root);
  return board.moveTicket(id, status, options);
}

export async function assignTicket(root, id, assignee, options) {
  const board = await BoardStore.open(root);
  return board.assignTicket(id, assignee, options);
}

export async function postMessage(root, id, message) {
  const board = await BoardStore.open(root);
  return board.addComment(id, message);
}
