export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];
export const PRIORITY_ALIASES = {
  p0: 'highest',
  p1: 'high',
  p2: 'medium',
  p3: 'low',
  p4: 'lowest',
  urgent: 'highest',
  critical: 'highest',
  normal: 'medium',
  mid: 'medium',
  minor: 'low',
  trivial: 'lowest',
};

export function normalizePriority(value, { fallback = 'medium', strict = true } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (PRIORITIES.includes(raw)) return raw;
  if (PRIORITY_ALIASES[raw]) return PRIORITY_ALIASES[raw];
  if (!strict) return fallback;
  throw new Error(`Unknown priority "${value}". Valid: ${PRIORITIES.join(', ')} or p0-p4.`);
}

export function priorityRank(priority) {
  const index = PRIORITIES.indexOf(normalizePriority(priority));
  return index < 0 ? PRIORITIES.indexOf('medium') : index;
}
