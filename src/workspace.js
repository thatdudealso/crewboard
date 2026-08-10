import fs from 'node:fs/promises';
import path from 'node:path';
import { BoardStore } from './store.js';
import { pathExists } from './utils.js';

export async function initializeWorkspace(filePath) {
  if (await pathExists(filePath)) throw new Error(`Workspace already exists at ${filePath}`);
  const workspace = { schemaVersion: 1, projects: [] };
  await fs.writeFile(filePath, `${JSON.stringify(workspace, null, 2)}\n`);
  return { filePath, workspace };
}

export async function openWorkspace(filePath) {
  try {
    return { filePath, workspace: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Workspace not found at ${filePath}. Run \`crewboard workspace init\`.`);
    throw error;
  }
}

export async function addBoardToWorkspace(filePath, boardPath) {
  const { workspace } = await openWorkspace(filePath);
  const absoluteBoardPath = path.resolve(boardPath);
  const board = await BoardStore.open(absoluteBoardPath);
  const existing = workspace.projects.find((project) => project.path === absoluteBoardPath);
  if (existing) return { filePath, workspace, project: existing, unchanged: true };
  const project = { name: board.config.name, path: absoluteBoardPath };
  workspace.projects.push(project);
  await fs.writeFile(filePath, `${JSON.stringify(workspace, null, 2)}\n`);
  return { filePath, workspace, project, unchanged: false };
}

export async function listWorkspace(filePath) {
  const { workspace } = await openWorkspace(filePath);
  const projects = await Promise.all(workspace.projects.map(async (project) => {
    const board = await BoardStore.open(project.path);
    return { ...project, columns: board.config.columns, tickets: await board.listTickets() };
  }));
  return { filePath, projects };
}
