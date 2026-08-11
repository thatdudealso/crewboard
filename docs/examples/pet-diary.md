# Pet Diary hierarchy example

Captain reference for the work hierarchy: **project > story > task > subtask**.

## Seed

```sh
crewboard init --name "Pet Diary"
crewboard create "Complete pet diary app with information collection" --type story --json
# use the returned story id as --parent below
crewboard create "Premium features" --type task --parent <story-id> --json
crewboard create "Role-aware logins" --type task --parent <story-id> --json
crewboard create "Digestive Pulse analysis" --type subtask --parent <premium-features-id>
crewboard create "subscription/trial flow" --type subtask --parent <premium-features-id>
crewboard create "organization login" --type subtask --parent <role-aware-logins-id>
crewboard create "adopter login" --type subtask --parent <role-aware-logins-id>
crewboard create "foster login" --type subtask --parent <role-aware-logins-id>
crewboard tree --json
```

Ticket ids look like `premium-features-x4f2`. Unambiguous prefixes resolve on lookup. Legacy `CB-*` ids remain aliases after migration.

## Screenshots

- `screenshots/board-before.png` — prior board UI (cramped done column, long CB ids)
- `screenshots/board-after.png` — hierarchy-aware board with equal columns and short ids


## Jira-grade screenshots

- `screenshots/jira-board.png` — equal-height columns, WIP counts, progress, quick actions
- `screenshots/jira-tree.png` — expandable structure outline
- `screenshots/jira-filters.png` — combined filters with visible chips
- `screenshots/jira-detail.png` — ticket detail with breadcrumb, children, activity, comments
