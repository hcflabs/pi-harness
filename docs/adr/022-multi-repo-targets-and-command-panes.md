# 022. Multi-Repo Targets and Command Panes

- **Status:** accepted
- **Date:** 2026-10-23
- **Updated:** 2026-10-25. [ADR 019](019-pi-subagent-orchestration.md) owns the delegation rules and [ADR 021](021-herdr-workflow-consolidation.md) owns the handoff and completion rules. This ADR keeps the shared repository and command-pane decisions.

## Context

Users often start Pi in a parent directory that is not a Git repository. For example, one directory can hold more than 70 independent child repositories at depths 1 to 3. From such a directory, these features fail or degrade:

- Direct `delegate_task` runs, but the checkout admission key is the parent path. All child repositories share one writer reservation, and the extension makes no change report.
- Isolated `delegate_task` fails. It resolves the canonical root from the Pi working directory and requires the caller's Herdr workspace to be a worktree of that root.
- Isolated changesets require a root `package.json` test script and run `pnpm test` ([ADR 019](019-pi-subagent-orchestration.md)). Most repositories in this example use Go, OpenTofu, or uv with a `Makefile`.
- `herdr_handoff` and `/done` run Git in the Pi working directory.
- No agent tool can run a long command in a Herdr pane and read its output.

Herdr 0.9.5 can do the Git workspace work without a parent workspace. A probe from a non-Git directory showed these results:

- `herdr worktree create --cwd <repo> ...` and `herdr worktree open --cwd <primary> --path <worktree> ...` succeed. Herdr creates a primary workspace for the repository when none is open.
- `herdr tab create --workspace <caller> --cwd <repo>` opens a tab in a child repository.
- Herdr reports some paths without symlink resolution (`/tmp/...`) and some with it (`/private/tmp/...`).

## Decision

### Repository targets

A **Repository target** is a Git top-level directory that a request selects with a `repo` field. The field is a path relative to the Pi working directory.

The validator accepts a target only when all of these conditions are true:

- The path is relative, is not empty, and has no `..` component.
- The real path is inside the real Pi working directory.
- The real path is equal to the Git top-level that Git reports for it. A subdirectory of a repository is rejected.

Code compares real paths on both sides, because Herdr and Git can report different spellings of the same path. Git timeouts, ownership errors, and malformed output are failures. They are never "not a repository".

A request without `repo` keeps its earlier behavior. No tool selects a child repository automatically, also when discovery finds only one.

### Shared repository package

A new library, `@hcflabs/pi-repo`, owns these mechanics:

- canonical Git root resolution
- Repository target validation
- child repository discovery

It has no policy for Roles, config, admission, Herdr, suites, or integration. `pi-subagent` and `pi-herdr-tools` use it. Neither imports source from the other.

### Discovery

`pi-subagent` registers a read-only `subagent_repos` tool. It lists child repositories and returns the `repo` selector that the other tools accept. Rules:

- The default depth is 3. Discovery stops at a repository and does not descend into it.
- It does not follow symlinked directories.
- It skips `.git`, `.worktrees`, `.scratch-*`, `node_modules`, `.terraform`, and `venv`.
- It checks each candidate with Git. A `.git` marker alone is not proof.
- It has limits on directory count, result count, and time. It reports truncation and inaccessible candidates.
- It changes no files, Git state, or Herdr state.

### Herdr workspaces

The extensions do not find or create a primary repository workspace. Herdr does this when it runs `worktree create` or `worktree open` with `--cwd`. Consequences:

- Direct workers open in the caller's workspace with `--cwd` set to the Repository target.
- Isolated worker worktrees open with `worktree open --cwd <primary>`. The caller's workspace does not need to belong to the target repository.
- `herdr_handoff` creates its worktree with `worktree create --cwd <repo>`.

### Delegation, handoff, and completion

- [ADR 019](019-pi-subagent-orchestration.md) owns Repository targets in direct and isolated delegation, scoped checkout admission, the Full suite, run state version 6, and child tool exclusion.
- [ADR 021](021-herdr-workflow-consolidation.md) owns `herdr_handoff` with `repo` and workspace-based `/done`.

### Long-running Main activity

Trusted tools can report long-running Main activity with two Pi events, `pi:checkout-activity:start` and `pi:checkout-activity:end`. Each event carries an exact job ID. The start event also carries the resolved scope. A direct writer cannot start while a conflicting activity is open. An activity ends only after the tool proves that its process stopped. The events coordinate one Pi session. They are not a sandbox.

### Command panes

`pi-herdr-tools` registers `herdr_command` through its existing entry point ([ADR 021](021-herdr-workflow-consolidation.md)). It has three actions:

- `start` runs an executable with an argument list in a new split pane. It takes optional `repo` and `cwd` fields and a required `access` field. It returns a job ID immediately.
- `read` returns a bounded snapshot of recent pane output and the saved process status. It never waits for the command to finish.
- `stop` stops the job and closes only its own pane.

Rules:

- The tool takes no shell string. A caller that needs a shell names the shell as the executable.
- A small helper starts the command and saves the exit code and signal outside the terminal. Code never reads the exit status from screen text.
- Config limits the number of active jobs, the run time, and the output size. No config value can remove a limit.
- Only Main can use the tool. Job IDs are opaque, and the tool accepts no raw pane ID.
- A `write` job reports checkout activity until it stops.
- Pane output is untrusted text. It is not evidence for isolated validation.

## Consequences

- Users can start Pi in a parent directory and delegate to, hand off from, and run commands in its child repositories.
- Herdr can create a primary workspace for a repository as a side effect. The extensions do not close it.
- `herdr_command` gives Main a new way to run processes. It does not authorize push, publication, or deployment. It is not a sandbox.
