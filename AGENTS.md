# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run `npm test` and `npm run lint` before handing off changes.
- `README.md` is the public CLI and storage contract; keep it aligned with `src/cli.js` when commands change.
- Board data is intentionally tracked in `.crewboard/`; do not add it to `.gitignore`.
- Work hierarchy is story → task → subtask (`--type` / `--parent`); short slug ids live in ticket files with legacy `CB-*` aliases. See `src/ids.js`, `src/hierarchy.js`, and `docs/examples/pet-diary.md`.
- Fleet leader is `firstmate` in `.crewboard/agents.json` (`crewboard agents`), not a project.
- The always-on fleet rollout contract is `agents/crewboard-fleet-contract.md`; apply `skills/crewboard-ticket/SKILL.md` whenever project work creates or updates a ticket.
- Captain GitHub attention: `crewboard github attention` / web **GitHub attention** view; config is `githubAttention` in the workspace file (see README). Server fetches via local `gh`; never treat an unavailable GitHub source as an empty all-clear.
- Captain web UI assets live in `src/web-ui/` (`app.css` / `app.js`); keep containment, truncation, visual grouping (section/field groups), and the calm dark depth system when editing presentation.
- Board poll skips re-render when `/api/board` is unchanged and restores scroll across forced renders (`boardFingerprint` / `captureScroll` in `src/web-ui/app.js`).
- Web screenshots via chrome-devtools-axi: write under `/tmp` first, then copy into the repo (direct worktree paths can false-succeed with no file).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
