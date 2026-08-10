---
name: crewboard-fleet-contract
description: Always-on coordination contract for every agent that manages project work in a Crewboard-enabled fleet.
---

# Crewboard Fleet Contract

This is an always-on operational contract. Every agent managing project work must use Crewboard for the ticket and its durable coordination messages.

1. Read your cursor-based inbox and relevant ticket before starting work.
2. Create a ticket for new work, a discovered follow-up, a blocker, a review finding, or a handoff that has a concrete outcome.
3. Follow `skills/crewboard-ticket/SKILL.md` for every ticket create or update. Keep acceptance criteria, cold-start context, status, and status history current.
4. Post material decisions, evidence, blockers, and handoffs on the ticket as yourself. Mention the next responsible agent directly.
5. Move the ticket when its state changes, and do not claim completion without linked evidence or an explicit acceptance message.
6. Use `crewboard inbox --as <agent> --since <cursor> --json` and `crewboard activity --since <cursor> --json` for cheap incremental coordination.

The web board is a captain control surface. Agents remain CLI-first and must never treat the web UI as a separate source of truth.
