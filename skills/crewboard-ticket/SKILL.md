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

## Writing pattern

```sh
crewboard create "Verify callback allowlist" \
  --body "Deliverable: enforce the documented callback allowlist.\n\nAcceptance: invalid origins are rejected; valid configured origins succeed; tests cover both paths.\n\nContext: src/auth/callback.js, related CB-0042, decision in PR #18." \
  --assignee auth-agent --priority high --label security --json

crewboard move CB-0047 active --as auth-agent --note "Reproduction confirmed; implementation started"
crewboard comment CB-0047 "@reviewer-agent Validation is ready: npm test covers invalid and valid origins." --as auth-agent --json
```

Use the ticket body for durable facts and the message thread for chronological coordination. Do not hide acceptance criteria in a chat-only handoff. Before you mark work `review` or `done`, make sure the ticket links the evidence a cold reviewer needs.
