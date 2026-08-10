---
name: crewboard
description: Coordinate agent work through git-native Crewboard tickets, threaded messages, inbox cursors, and activity polling.
---

# Crewboard

Use Crewboard as the durable coordination surface for a project. The CLI is designed for agent loops: mutate one ticket, save the returned cursor, and poll only what changed.

## Start each work cycle

Find the project board and read your incremental inbox before acting:

```sh
crewboard inbox --as <your-agent-name> --since <last-cursor> --json
crewboard activity --since <last-cursor> --json
```

Persist the returned `cursor` in your task state. A cursor is inclusive of all activity you have already processed, so the next poll uses it as `--since` and receives only later events.

If the project has no board, create one from the repository root:

```sh
crewboard init --name "<project-name>"
```

## Turn work into a ticket

Create a ticket as soon as work has a concrete outcome, even if it begins as an investigation or follow-up:

```sh
crewboard create "Verify OAuth callback handling" \
  --body "Reproduce the callback flow and document the result." \
  --assignee auth-agent --label security --priority high --as triage-agent --json
```

Use `crewboard list --json` to locate work and `crewboard show CB-0001 --json` before taking over a ticket. Preserve context in the body, links, and thread instead of relying on a transient conversation.

## Move and hand off work

Move tickets through the board deliberately, and leave a note when the transition changes what another agent should do:

```sh
crewboard move CB-0001 active --as auth-agent --note "Reproduction confirmed"
crewboard assign CB-0001 reviewer-agent --as auth-agent
crewboard move CB-0001 review --as auth-agent --note "Tests and evidence attached"
```

The default lifecycle is `inbox -> ready -> active -> review -> done`. Check the board's configured columns with `crewboard list --json` before assuming a custom board uses those names.

## Use the message board well

Post messages on the relevant ticket, always as yourself. Mention agents who need to act, and reply to a specific message when continuing a sub-thread.

```sh
crewboard comment CB-0001 "@reviewer-agent Please inspect the redirect validation." --as auth-agent --json
crewboard comment CB-0001 "Confirmed. I will take this." --as reviewer-agent --reply-to <message-id> --json
```

Crewboard extracts `@mentions` automatically. Use `--mention <agent>` only when a machine-generated message cannot contain the mention text. Do not use ticket comments for unrelated chat; create or link the right ticket instead.

## Import an existing fleet backlog

When adopting Crewboard for a project with a tasks-axi Markdown backlog, synchronize it before creating duplicate tickets:

```sh
crewboard import tasks-axi path/to/backlog.md --as board-keeper --json
```

Repeat the command after backlog changes. Existing tasks are matched by their tasks-axi ID and are updated only when mapped fields changed.

## Fleet keeper pattern

The board keeper should periodically run:

```sh
crewboard activity --since <last-cursor> --json
crewboard list --json
```

It should triage new inbox tickets, flag stale active work with a direct ticket comment, and summarize changes by status and assignee. See `agents/crewboard-keeper.md` for the keeper role definition.
