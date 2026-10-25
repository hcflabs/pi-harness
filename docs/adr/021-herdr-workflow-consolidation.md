# 021. One Herdr Workflow Extension

- **Status:** accepted
- **Date:** 2026-10-05
- **Updated:** 2026-10-25. This ADR includes the handoff and completion rules from [ADR 022](022-multi-repo-targets-and-command-panes.md).

`@hcflabs/pi-herdr-tools` supplies clone, completion, side-thread, and title behavior in one package with one extension entry point. Each feature stays in a separate internal module, so each feature keeps its own safety boundaries. This design reduces installation and loaded-extension count. The shared `@hcflabs/pi-herdr` CLI library remains separate for other consumers.

We accept that users cannot select one feature as a native Pi resource. We do not add feature-toggle configuration or wrapper packages. Commands, task-model IDs, title session entries, side-thread payload flags, config paths, and pending-delivery storage keep their earlier identifiers. Thus, existing user data stays valid without migration.

## Handoff and completion

- `herdr_handoff` accepts an optional `repo` Repository target ([ADR 022](022-multi-repo-targets-and-command-panes.md)). With `repo`, it runs its Git checks in that repository and creates the worktree with `--cwd`. Without `repo`, it uses the repository of the current Herdr workspace and requires that the Pi working directory is in the same repository.
- Agents use `herdr_handoff` within the authorized scope of the user. Its guidance states that a handoff has no checked integration.
- `/done` gets its checkout from the Herdr workspace of the current pane, not from the Pi working directory. It refuses a workspace that is not a linked worktree.

The `herdr_command` tool also uses this entry point. ADR 022 owns its rules.
