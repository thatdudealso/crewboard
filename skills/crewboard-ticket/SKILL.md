---
name: crewboard-ticket
description: Create and maintain Crewboard tickets that another agent can pick up cold, with concrete acceptance criteria, durable context, and current status history.
---

# Crewboard Ticket Quality

Use this skill whenever you create, edit, move, or hand off a Crewboard ticket. A ticket is the durable operational record, not a reminder to reconstruct later.

## Required ticket contract

Every ticket must make four things unambiguous:

1. **Deliverable and acceptance criteria** - State the concrete thing being delivered and how a reviewer knows it is complete. Put this in the body, not only a vague title.
2. **Current state** - Keep the board status, assignee, priority, and next action precise as work changes. Move the ticket promptly rather than treating `active` as a catch-all.
3. **Cold-start context** - Include relevant repository paths, links, PRs, related ticket IDs, decisions already made, constraints, evidence, and the smallest useful reproduction or verification command.
4. **Status history** - Use status moves and dated ticket messages to record material progress, handoffs, blockers, and decisions. Crewboard records the status history automatically; explain why a transition happened in the move note or thread.

## Hierarchy and ids

Every new ticket must sit in the work hierarchy: **story → task → subtask** inside a project board.

- Stories are large outcomes (`--type story`).
- Every new task must be parented to a story (`--type task --parent <story-id>`). If no suitable story exists, create one first. Unparented tasks are only valid as legacy or imported tickets; the structure view groups them under a visible "No story" bucket until they are reparented.
- Subtasks belong to a task (`--type subtask --parent <task-id>`).

Ticket ids are short readable slugs with a suffix, for example `premium-features-x4f2`. Use the id returned by `create`, or an unambiguous prefix, in later commands. Legacy `CB-*` ids still resolve as aliases after migration.

```sh
crewboard create "Premium features" --type task --parent <story-id> \
  --body "Deliverable: ship premium analysis and trial flow.\n\nAcceptance: Digestive Pulse and subscription/trial subtasks done; tests green." \
  --assignee builder --priority high --json

crewboard create "Digestive Pulse analysis" --type subtask --parent <premium-features-id> --json
crewboard tree <story-id> --json
```

## Writing pattern

```sh
crewboard create "Verify callback allowlist" --type task \
  --body "Deliverable: enforce the documented callback allowlist.\n\nAcceptance: invalid origins are rejected; valid configured origins succeed; tests cover both paths.\n\nContext: src/auth/callback.js, related premium-features-x4f2, decision in PR #18." \
  --assignee auth-agent --priority high --label security --json

crewboard move <ticket-id-from-create> active --as auth-agent --note "Reproduction confirmed; implementation started"
crewboard comment <ticket-id-from-create> "@reviewer-agent Validation is ready: npm test covers invalid and valid origins." --as auth-agent --json
```

When `firstmate` assigns work, pass `--as firstmate` so `assignedBy` is recorded. Use the ticket body for durable facts and the message thread for chronological coordination. Do not hide acceptance criteria in a chat-only handoff. Before you mark work `review` or `done`, make sure the ticket links the evidence a cold reviewer needs.
