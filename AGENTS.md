# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run `npm test` and `npm run lint` before handing off changes.
- `README.md` is the public CLI and storage contract; keep it aligned with `src/cli.js` when commands change.
- Board data is intentionally tracked in `.crewboard/`; do not add it to `.gitignore`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
