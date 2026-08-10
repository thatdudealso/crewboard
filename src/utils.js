import path from 'node:path';
import { access } from 'node:fs/promises';

export const DEFAULT_COLUMNS = ['inbox', 'ready', 'active', 'review', 'done'];

export function now() {
  return new Date().toISOString();
}

export function cleanList(values = []) {
  return [...new Set(values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean))];
}

export function mentionsIn(text) {
  return [...new Set([...String(text).matchAll(/(^|[^A-Za-z0-9_-])@([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((match) => match[2]))];
}

export function eventCursor(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid cursor: ${value}`);
  return parsed;
}

export function summarize(text, maxLength = 88) {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function findBoardRoot(startDirectory) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (await pathExists(path.join(current, '.crewboard', 'board.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('No Crewboard found. Run `crewboard init` or pass --board <path>.');
}

export function normalizeBoardRoot(boardPath, cwd) {
  return path.resolve(cwd, boardPath);
}
