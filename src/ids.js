import crypto from 'node:crypto';

export const LEGACY_TICKET_ID = /^CB-\d{4,}$/;
export const SHORT_TICKET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{4}$/;

export function isTicketId(value) {
  return typeof value === 'string' && (SHORT_TICKET_ID.test(value) || LEGACY_TICKET_ID.test(value));
}

export function slugifyTitle(title, { maxLength = 48 } = {}) {
  const slug = String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'ticket';
  if (slug.length <= maxLength) return slug;
  const truncated = slug.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf('-');
  return (lastHyphen > 8 ? truncated.slice(0, lastHyphen) : truncated).replace(/-+$/g, '') || 'ticket';
}

export function shortSuffix() {
  return crypto.randomBytes(2).toString('hex');
}

export function generateTicketId(title, existingIds = new Set()) {
  const slug = slugifyTitle(title);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const id = `${slug}-${shortSuffix()}`;
    if (!existingIds.has(id)) return id;
  }
  throw new Error('Unable to allocate a unique ticket id.');
}

export function ticketFileName(ticketId) {
  if (!isTicketId(ticketId)) throw new Error(`Invalid ticket id: ${ticketId}`);
  return `${ticketId}.md`;
}

export function resolveTicketQuery(query, tickets) {
  const needle = String(query || '').trim();
  if (!needle) throw new Error('A ticket id is required.');
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  if (byId.has(needle)) return byId.get(needle);
  const byAlias = tickets.find((ticket) => (ticket.aliases || []).includes(needle));
  if (byAlias) return byAlias;
  const prefixMatches = tickets.filter((ticket) => (
    ticket.id.startsWith(needle)
    || (ticket.aliases || []).some((alias) => alias.startsWith(needle))
  ));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) throw new Error(`Ambiguous ticket id prefix: ${needle}`);
  throw new Error(`Ticket not found: ${needle}`);
}
