import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { now, pathExists } from './utils.js';

export const LEADER_AGENT = {
  name: 'firstmate',
  role: 'leader',
  description: 'leads the fleet, triages, assigns all work to agents',
};

export const DEFAULT_AGENTS = [
  LEADER_AGENT,
  { name: 'scout', role: 'agent', description: 'explores and reports findings for the fleet' },
  { name: 'worker', role: 'agent', description: 'implements assigned tickets' },
];

function agentsPath(boardPath) {
  return path.join(boardPath, 'agents.json');
}

export async function ensureAgentsRegistry(boardPath) {
  const filePath = agentsPath(boardPath);
  if (!(await pathExists(filePath))) {
    const registry = {
      schemaVersion: 1,
      agents: DEFAULT_AGENTS,
      updatedAt: now(),
    };
    await atomicWriteFile(filePath, `${JSON.stringify(registry, null, 2)}\n`);
    return registry;
  }
  const registry = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const agents = Array.isArray(registry.agents) ? [...registry.agents] : [];
  if (!agents.some((agent) => agent.name === LEADER_AGENT.name)) {
    agents.unshift(LEADER_AGENT);
    registry.agents = agents;
    registry.updatedAt = now();
    await atomicWriteFile(filePath, `${JSON.stringify(registry, null, 2)}\n`);
  }
  return registry;
}

export async function listAgents(boardPath) {
  return ensureAgentsRegistry(boardPath);
}

export function agentByName(registry, name) {
  if (!name) return null;
  return registry.agents.find((agent) => agent.name === name) || null;
}
