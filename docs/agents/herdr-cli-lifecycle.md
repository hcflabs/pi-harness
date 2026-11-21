# Herdr CLI Lifecycle and Timing (0.9.5)

This file records the Herdr CLI lifecycle rules that our Node packages depend on. It targets Herdr 0.9.5, the version audited in [Herdr Version Upgrade](./herdr-version-upgrade.md). The consumers are `@hcflabs/pi-herdr`, `pi-herdr-tools`, and `pi-subagent`.

## Summary

- Creation commands make Herdr objects. They do not make a ready shell. A caller must prove shell readiness before it types a command.
- `tab create` and `pane split` start an empty shell. Our consumers pass no command at creation time. They start an agent or type into the shell afterwards.
- Focus is UI state. It does not change the result of a CLI call that names an explicit ID. Use `--no-focus` on every creation call that a non-interactive caller owns.
- `pane run` types text into whatever owns the pane foreground. It does not wait for the shell.
- An agent needs an empty, idle shell pane. Herdr refuses a busy pane with `agent_pane_busy`.
- Closing a pane does not prove that its processes ended. Signal and prove the process end yourself.
- Every claim below links to its source. Where the source is a consumer call site, that call site is the observed form of the 0.9.5 binary output.

### How the sources were checked

The task names three source tiers. This session had no shell tool, so it could not run `herdr --version`, `herdr --skill`, or `herdr <group>`. The binary is at 0.9.5 per the audit log in [Herdr Version Upgrade](./herdr-version-upgrade.md). This file therefore cites two kinds of evidence:

1. Consumer call sites in this repository. These show the exact argv and the exact JSON paths that the consumers read from the installed 0.9.5 binary, and they run against it in the `direct-e2e` test.
2. The upstream pages at tag `v0.9.5`. These own the semantics that the consumers rely on.

Where a claim rests on an upstream page only, the text says so. Items marked "Not confirmed by a call site" were not exercised by this repository.

## Creation

### `workspace create`

`herdr workspace create --cwd <path> --label <label> --no-focus` makes a workspace with one root tab and one root pane. Our packages never call `workspace create`. They let `worktree create` and `worktree open` make the workspace, and they record the returned `workspace_id`. Herdr makes a primary repository workspace when it gets `--cwd` ([ADR 022](../adr/022-multi-repo-targets-and-command-panes.md), [pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)). Not confirmed by a call site.

### `worktree create`

`pi-herdr-tools` calls:

```
herdr worktree create --workspace <parent-workspace> --branch <branch> --base main --label <label> --no-focus
herdr worktree create --cwd <repo> --branch <branch> --base main --label <label> --no-focus
```

The second form works from a directory that is not a Git repository. Herdr then opens the repository primary workspace, or creates it ([handoff.ts](../../extensions/pi-herdr-tools/internal/handoff.ts), [ADR 022](../adr/022-multi-repo-targets-and-command-panes.md)). Herdr checks out an existing branch instead of creating it from `--base` ([handoff.ts](../../extensions/pi-herdr-tools/internal/handoff.ts)). A linked worktree must use the repository parent workspace, not its own workspace ([worktree.ts](../../extensions/pi-herdr-tools/internal/worktree.ts)).

The response nests these fields ([worktree.ts](../../extensions/pi-herdr-tools/internal/worktree.ts)):

- `result.workspace.workspace_id`
- `result.workspace.worktree.checkout_path`
- `result.tab.tab_id`
- `result.root_pane.pane_id`
- `result.worktree.path` (the top-level worktree object uses `path`, not `checkout_path`)

`pi-subagent` uses the other creator, `herdr worktree open --cwd <repo-root> --path <checkout> --label <label> --no-focus`. It requires `result.type === "worktree_opened"`, `already_open === false`, `focused === false` on the workspace, tab, and pane, and `workspace.worktree.checkout_path`, `repo_key`, and `repo_root` equal to the intended values ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). A killed create is ambiguous. Herdr can keep partial state. The consumer reports every ID that it saw and does not retry blindly ([worktree.ts](../../extensions/pi-herdr-tools/internal/worktree.ts), [pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)).

### `tab create`

```
herdr tab create --workspace <workspace-id> --cwd <path> --label <label> --env NAME=value --no-focus
```

The call sites are [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts), [clone-tab.ts](../../extensions/pi-herdr-tools/internal/clone-tab.ts), and [worktree.ts](../../extensions/pi-herdr-tools/internal/worktree.ts). No call site passes a command. The new root pane starts an empty shell.

The response nests these fields ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)):

- `result.type === "tab_created"`
- `result.tab.tab_id`, `result.tab.workspace_id`, `result.tab.label`, `result.tab.focused`, `result.tab.pane_count`
- `result.root_pane.pane_id`, `result.root_pane.workspace_id`, `result.root_pane.tab_id`, `result.root_pane.cwd`, `result.root_pane.focused`

Consumers validate `focused === false`, `pane_count === 1`, and the exact `cwd` before they use the IDs ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### `pane split`

```
herdr pane split --pane <parent-pane> --direction right|down --cwd <path> --no-focus
herdr pane split --pane <parent-pane> --direction right|down --cwd <path> --focus
```

The response gives `result.pane.pane_id`, `result.pane.terminal_id`, `result.pane.cwd`, and `result.pane.focused` ([command.ts](../../extensions/pi-herdr-tools/internal/command.ts), [core.ts](../../extensions/pi-herdr-tools/internal/core.ts)). The new pane starts an empty shell. `/btw` splits, then adopts Pi into the pane with `agent start` ([core.ts](../../extensions/pi-herdr-tools/internal/core.ts)).

Herdr 0.7 removed pane creation from `agent start`. A caller must make the pane first ([core.ts](../../extensions/pi-herdr-tools/internal/core.ts)).

## Readiness and timing

### What a creation call guarantees

A creation call returns after Herdr made the object and assigned its IDs. It does not guarantee that the shell in the new pane reads input. Two consumers prove this in code:

- `awaitShellPrompt` exists because a fresh pane can still run its startup files ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)).
- `pi-subagent` polls `pane process-info` every 100 ms for up to 20 s until the shell owns the foreground, then probes the prompt ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)).

### The readiness probe

The supported way to wait for a shell is a probe, not a sleep ([packages/pi-herdr/README.md](../../packages/pi-herdr/README.md), [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)):

1. Run `herdr pane process-info --pane <pane>`. The probe passes when `foreground_process_group_id === shell_pid`.
2. Run `herdr pane run <pane> "echo <token>"`.
3. Poll `herdr pane read <pane> --source recent-unwrapped --lines 40 --format text` every 100 ms for at most 20 s. The probe passes when the token appears on its own line and a non-blank line follows it.

The prompt is drawn only when the shell is about to read. The non-blank line after the token is the proof that the shell reached its prompt.

### macOS 1024-byte input limit

On macOS, a shell that still runs startup files or a prompt hook leaves the terminal in canonical mode. In that mode macOS caps one pending input line at 1024 bytes and drops Enter for a longer line. A launch command above 1024 bytes then never runs, and the pane waits forever ([packages/pi-herdr/README.md](../../packages/pi-herdr/README.md), [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)). Herdr 0.9.4 adds a refusal for a too-long command to a starting shell (issue #4950). The error code is not documented, so our consumers still use the probe ([Herdr Version Upgrade](./herdr-version-upgrade.md)).

### Which commands wait

| Command | Waits? | Source |
| --- | --- | --- |
| `tab create`, `pane split`, `worktree create` | No. Returns IDs before the shell reads input. | [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts) |
| `pane run` | No. Types the text and returns. | [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts) |
| `pane read` | No. Returns the current screen text. | [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts) |
| `agent start` | Waits only for the agent to start. The caller must prove shell readiness first. | [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts) |
| `agent prompt --wait --until <state> --timeout <ms>` | Yes. Blocks until a listed state or the timeout. | [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts) |
| `agent wait <name> --until <state> --timeout <ms>` | Yes. | [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts) |
| `agent prompt` without `--wait` | No. Acknowledges submission only. | [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts) |

`pi-subagent` treats `timeout` as retryable and re-issues `agent wait`. It treats `agent_prompt_stalled` as "the prompt may have arrived" and reconciles before it sends again ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)).

### Races between creation and typing

`pane run` types into whatever owns the pane foreground. A caller that needs the shell must fail when another program owns the foreground ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)). A layout plugin can claim the root pane of a new worktree within a second. `pi-herdr-tools` polls `pane get` for 12 × 250 ms, then moves the agent to its own tab if the root pane is claimed ([worktree.ts](../../extensions/pi-herdr-tools/internal/worktree.ts)). `pi-subagent` waits for the workspace pane list to stay constant before it creates a worker tab ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)).

## Focus

| Command | Changes focus? | Suppress with | Source |
| --- | --- | --- | --- |
| `tab create` | Yes, unless suppressed | `--no-focus` | [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts) |
| `pane split` | Only with `--focus`. `/btw` passes `--focus` to move the user to the side pane; `herdr_command` passes `--no-focus` to keep Main's focus. | `--no-focus` | [command.ts](../../extensions/pi-herdr-tools/internal/command.ts), [core.ts](../../extensions/pi-herdr-tools/internal/core.ts) |
| `worktree create`, `worktree open` | Yes, unless suppressed | `--no-focus` | [handoff.ts](../../extensions/pi-herdr-tools/internal/handoff.ts), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts) |
| `agent start` | No. It adopts an existing pane. | n/a | [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts) |
| `agent focus <pane>` | Yes | n/a | [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts) |
| `tab focus <tab>` | Yes | n/a | [clone-tab.ts](../../extensions/pi-herdr-tools/internal/clone-tab.ts) |
| `tab close`, `pane close`, `workspace close` | Not specified. Do not rely on it. | n/a | [done.ts](../../extensions/pi-herdr-tools/internal/done.ts) |

Focus does not change the result of a CLI call that names an explicit ID. Every consumer call passes explicit pane, tab, or workspace IDs, or `--workspace`, and runs with a `cwd` option. The caller pane comes from `HERDR_PANE_ID`, not from the focused pane ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [command.ts](../../extensions/pi-herdr-tools/internal/command.ts)). `pane current --current` resolves the calling pane from the environment ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

Focus changes the UI for the human. A background worker must not steal it. Use `--no-focus` on every creation call, and call `agent focus` or `tab focus` only after a user action.

## Running commands in panes

### `pane run`

```
herdr pane run <pane-id> <text>
```

Herdr types `text` into the pane and sends Enter. It does not start a process itself and does not wait. The text goes to the foreground program. If the shell does not own the foreground, the text goes to that program ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)). `pane run` reports success when Herdr sent the text, not when the command ended ([command.ts](../../extensions/pi-herdr-tools/internal/command.ts)).

Our consumers pass one argument, so no shell parsing happens on the Herdr side. `herdr_command` builds a shell-quoted line from an executable and its arguments ([command.ts](../../extensions/pi-herdr-tools/internal/command.ts)).

### `pane read`

```
herdr pane read <pane-id> --source recent-unwrapped --lines 40 --format text
herdr agent read <name> --source recent --lines 80 --format text
```

The sources that our consumers use are `recent` and `recent-unwrapped`. The formats are `text` and `json`. The output is terminal text and is untrusted ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). Never read an exit status from the screen. `herdr_command` saves the exit status in a private file ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)). Other sources and formats are listed in the [CLI reference](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/cli-reference.mdx). Not confirmed by a call site.

### `pane process-info`

```
herdr pane process-info --pane <pane-id>
```

The response is `result.type === "pane_process_info"` with `result.process_info` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)):

- `pane_id`
- `shell_pid`
- `foreground_process_group_id`
- `foreground_processes[]` with `pid`, `name`, and `cwd`

The pane is an idle shell only when `foreground_process_group_id === shell_pid` and `foreground_processes` holds exactly one entry with `pid === shell_pid` and the expected `cwd` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). Startup-file children share the shell group. A program started from the prompt runs in its own group ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)).

### `pane get` and identity

`herdr pane get <pane-id>` returns `result.type === "pane_info"` with `result.pane.pane_id`, `tab_id`, `workspace_id`, `cwd`, `foreground_cwd`, `terminal_id`, `agent`, and `agent_status` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [command.ts](../../extensions/pi-herdr-tools/internal/command.ts)). Herdr can reuse a pane ID for a later pane. Compare `terminal_id` before you act on a saved pane ID ([command.ts](../../extensions/pi-herdr-tools/internal/command.ts)).

### `pane close`

```
herdr pane close <pane-id>
```

The response is `result.type === "ok"` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). A missing pane returns `pane_not_found` ([command.ts](../../extensions/pi-herdr-tools/internal/command.ts)). Closing a pane removes the pane. It does not prove that the processes that ran in it ended. `pi-subagent` closes the pane, then signals the lease holders with SIGTERM and SIGKILL and requires two empty scans ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)).

### `pane move`

`herdr pane move <pane-id> --tab <tab-id>` moves a pane into another tab. No consumer calls it. The pane ID stays the same. See the [CLI reference](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/cli-reference.mdx). Not confirmed by a call site.

## Agent lifecycle

### `agent start`

```
herdr agent start <name> --kind pi --pane <pane-id> -- <pi-arguments...>
```

Requirements that the consumers enforce before the call ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)):

- The target pane exists and belongs to the expected tab and workspace.
- `pane.cwd` and `pane.foreground_cwd` equal the intended checkout.
- `pane.agent` is absent or null and `pane.agent_status` is `"unknown"`. The pane is empty.
- The pane shell owns the foreground group, and the foreground is the shell only.
- The shell passes the prompt probe.
- The pane is not used by another agent. Herdr returns `agent_pane_busy` for an occupied pane ([packages/pi-herdr/README.md](../../packages/pi-herdr/README.md)).

`agent start` does not create a pane. Herdr 0.7 removed that behavior ([core.ts](../../extensions/pi-herdr-tools/internal/core.ts)). A caller must create the pane first and prove readiness.

Agent names must match `^[a-z][a-z0-9_-]{0,31}$` and be unique ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). Herdr rejects a multiline argument with `invalid_agent_argument` ([subagent.test.ts](../../extensions/pi-subagent/test/subagent.test.ts)).

The response is `result.type === "agent_started"` with `result.agent.name`, `pane_id`, `tab_id`, `workspace_id`, `cwd`, `agent_status`, and `interactive_ready` ([core.ts](../../extensions/pi-herdr-tools/internal/core.ts), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). A caller must require `interactive_ready === true` and `agent_status === "idle"` before it sends a prompt ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### `agent list` and `agent get`

`herdr agent list` returns `result.type === "agent_list"` with `result.agents[]`. Each entry has at least `name`, `pane_id`, and `tab_id` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

`herdr agent get <pane-id>` returns `result.type === "agent_info"` with the same agent object ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### `agent prompt`

```
herdr agent prompt <name> <prompt> --wait --until working --until done --until blocked --timeout <ms>
herdr agent prompt <name> <prompt> --wait --until working --timeout 30000
herdr agent prompt <name> <prompt>
```

`--wait` with `--until` blocks until one listed state or the timeout. Without `--wait` the call acknowledges submission only ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). The response is `result.type === "agent_prompted"` with the agent object. The prompt is one argument, not a shell command ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)). A timed-out prompt can still arrive. Check `agent get` before you send again ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)).

### `agent wait`

`herdr agent wait <name> --until idle --until done --until blocked --until working --until unknown --timeout <ms>` returns `agent_info` or `timeout` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### States

Herdr reports `idle`, `working`, `blocked`, `done`, and `unknown` in `agent.agent_status` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)). Only `idle` and `done` count as settled. `blocked` needs a user answer. `unknown` means the state cannot be proved. Our consumers treat any state outside `working`, `idle`, or `done` as a failure to inspect ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

`done` does not prove that the task succeeded. `pi-subagent` reads the Pi session file for the final turn ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### `agent send-keys`

`herdr agent send-keys <name> ctrl+c` sends a key sequence to the agent pane. Our consumers use it to cancel a run ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### `agent stop`, `agent release`, `agent kill`

No consumer in this repository calls these three commands. The descriptions below come from the [CLI reference](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/cli-reference.mdx) and were not confirmed by a call site.

| Command | Effect |
| --- | --- |
| `agent stop <name>` | Asks the agent to end its run. The pane stays. |
| `agent release <name>` | Removes the agent identity from the pane without stopping its process. |
| `agent kill <name>` | Ends the agent process. |

Our consumers end an agent differently: they send `ctrl+c`, close the pane, and signal the process lease holders ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts), [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)).

### When the agent process exits

The agent identity does not survive its process. An empty pane reports `pane.agent` null and `pane.agent_status === "unknown"`, and the name leaves `agent list` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)). A saved pane ID can belong to a later pane, so compare `terminal_id` ([command.ts](../../extensions/pi-herdr-tools/internal/command.ts)).

## Cleanup

### `tab close`

`herdr tab close <tab-id>` closes the tab and its panes. The response is `result.type === "ok"` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [done.ts](../../extensions/pi-herdr-tools/internal/done.ts)). `/done` closes the sibling tabs of the worktree workspace, then closes its own tab last, even when an earlier step fails ([done.ts](../../extensions/pi-herdr-tools/internal/done.ts)). `pi-subagent` closes a worker tab only after it proved that the tab is its owned tab with `pane_count === 0` ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)).

### `workspace close`

`herdr workspace close <workspace-id>` closes the workspace and its tabs. The response is `result.type === "ok"`. `pi-subagent` closes the workspace only after it closed the worker tab, so the root tab still exists and the close is recursive ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). Confirm absence with `workspace get`, which then returns an error ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)).

### `worktree remove`

`herdr worktree remove [--force] <checkout>` removes the checkout. Normal removal refuses a dirty worktree and refuses a checkout that another workspace uses. `--force` passes to Git and can delete uncommitted work ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md), [done.ts](../../extensions/pi-herdr-tools/internal/done.ts)). `/done` runs `git worktree remove` in the primary checkout, closes the tabs of the current workspace, then closes its own tab. Tabs in other workspaces do not close ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)).

### Do close commands kill processes?

Not reliably. Closing a pane or tab removes the Herdr object. Herdr does not prove that every descendant process ended. `pi-subagent` closes the pane, then signals each lease holder and requires two empty `lsof` scans. `herdr_command` signals the job process group, closes its pane, and then requires an empty lease and an empty group ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts), [command.ts](../../extensions/pi-herdr-tools/internal/command.ts)). A process that leaves the group and closes the lease escapes both proofs ([pi-herdr-tools README](../../extensions/pi-herdr-tools/README.md)).

### Agent before pane

Stop the agent before you close its pane. A live agent keeps the pane busy, so a later `agent start` in that pane fails with `agent_pane_busy` ([packages/pi-herdr/README.md](../../packages/pi-herdr/README.md)). Our consumers send `ctrl+c`, then close the pane ([direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts), [subagent.test.ts](../../extensions/pi-subagent/test/subagent.test.ts)). If the agent still runs after the pane closes, it is a process without a pane, and `agent list` can still show it ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)). The [CLI reference](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/cli-reference.mdx) states no requirement to stop an agent before you close its pane. Our rule comes from the consumers.

## Errors

### Envelope

Herdr writes a JSON error envelope to stdout or stderr:

```json
{"error":{"code":"agent_pane_busy","message":"pane is busy"}}
```

`@hcflabs/pi-herdr` detects the code in either stream ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts), [index.test.ts](../../extensions/pi-herdr-tools/test/index.test.ts)). The envelope schema is owned by [herdr-api.schema.json](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/api/herdr-api.schema.json).

### Exit codes

`herdr` exits non-zero for a structured error. Consumer tests model this as exit 1. The client treats any non-zero exit or a killed process as a failure and does not parse stdout for success ([packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts)). A killed process is ambiguous: Herdr can have completed the operation before the CLI died ([worktree.ts](../../extensions/pi-herdr-tools/internal/worktree.ts), [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts)).

### Codes that consumers handle

| Code | Meaning | Retryable? | Source |
| --- | --- | --- | --- |
| `agent_pane_busy` | The pane already holds an agent, or its shell does not own the foreground. | Yes, up to 5 tries with 250 ms delay. | [packages/pi-herdr/src/index.ts](../../packages/pi-herdr/src/index.ts) |
| `agent_prompt_stalled` | The prompt may not have arrived. | Reconcile with `agent get`, then resend only if absent. | [herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts) |
| `timeout` | `agent wait` or `agent prompt --wait` hit `--timeout`. | Yes. Re-issue the wait. | [direct-herdr.ts](../../extensions/pi-subagent/src/direct-herdr.ts) |
| `pane_not_found` | The pane does not exist. | No. The resource is gone. | [command.ts](../../extensions/pi-herdr-tools/internal/command.ts) |
| `agent_not_found` | The agent name does not exist. | No. Treat the agent as absent. | [btw.ts](../../extensions/pi-herdr-tools/internal/btw.ts) |
| `invalid_agent_argument` | An argument cannot be encoded, for example a multiline prompt. | No. Change the argument. | [subagent.test.ts](../../extensions/pi-subagent/test/subagent.test.ts) |

The schema lists more codes, for example `tab_not_found` and `workspace_not_found`. This file records only codes that a consumer handles ([herdr-api.schema.json](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/api/herdr-api.schema.json)).

### Preflight checks

Before any mutation, `pi-subagent` runs these read-only checks ([herdr-runtime.ts](../../extensions/pi-subagent/src/herdr-runtime.ts)):

- `herdr --version` prints `herdr <version>`, at least 0.9.3.
- `herdr status server` reports `status=running`, `endpoint_compatible=yes`, `private_protocol_compatible=yes`, and `private_protocol >= 22`.
- `herdr api schema --json` lists the capabilities that the consumer needs.
- `herdr pane get` and `herdr workspace get` match `HERDR_PANE_ID` and its workspace.

These commands are read-only and safe to run in a live session.

## Changelog notes for 0.9.4 and 0.9.5

- 0.9.4 refuses a too-long command for a shell that is still starting on macOS (issue #4950). The error code is not documented. Our probe still runs. Adopt the refusal only after a live test records a stable code ([Herdr Version Upgrade](./herdr-version-upgrade.md), [CHANGELOG](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/CHANGELOG.md)).
- 0.9.5 can create and open worktrees from a non-Git directory with `--cwd`, and can open a tab in a child repository with `tab create --cwd`. Herdr then creates the primary workspace of that repository ([ADR 022](../adr/022-multi-repo-targets-and-command-panes.md), [CHANGELOG](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/CHANGELOG.md)).
- The socket API protocol stays 22 across 0.9.3 to 0.9.5 ([Herdr Version Upgrade](./herdr-version-upgrade.md), [herdr-api.schema.json](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/api/herdr-api.schema.json)).
- No changelog item in 0.9.4 or 0.9.5 changes tab or pane creation timing. The readiness probe is still necessary ([Herdr Version Upgrade](./herdr-version-upgrade.md), [CHANGELOG](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/CHANGELOG.md)).

## Consumer checklist

Use these rules in every Node package that drives Herdr.

1. Check `herdr --version` and `herdr status server` before a mutation. Require at least 0.9.3 and private protocol 22.
2. Create the workspace, worktree, tab, or pane first. Pass `--no-focus`. Record every returned ID.
3. Validate the response. Require the expected `result.type`, the exact `workspace_id`, `tab_id`, `cwd`, and `focused === false`.
4. Prove shell readiness before you type into a new pane. Use `pane process-info`, then `pane run "echo <token>"`, then poll `pane read --source recent-unwrapped --lines 40 --format text` for at most 20 s. Require a prompt line after the token.
5. Keep every launch command below 1024 bytes on macOS, or rely on the readiness probe.
6. Start the agent only in an empty pane: `pane.agent` null, `pane.agent_status === "unknown"`, and the shell owns the foreground.
7. Require `interactive_ready === true` and `agent_status === "idle"` after `agent start`. Retry only `agent_pane_busy`, and only 5 times.
8. Send the prompt with `agent prompt --wait --until ... --timeout <ms>`. Treat a bare `agent prompt` as an acknowledgement, not as completion.
9. Poll with `agent wait --until idle --until done --until blocked --until unknown --timeout <ms>`. Never sleep and hope.
10. Read the real result from your own channel, for example the Pi session file. `agent_status === "done"` is not proof of success.
11. Save `terminal_id` with every pane ID. Compare it before you act on a saved pane.
12. Close only panes that you created. Close the tab before the workspace. Close a workspace only after you closed its worker tabs.
13. Signal the processes that you started before you close the pane. Then prove the end with two empty scans. Do not trust `pane close` to kill them.
14. Cancel the agent with `agent send-keys <name> ctrl+c` before you close its pane.
15. Never assume focus. Address every resource by ID. Call `agent focus` or `tab focus` only after a user action.
16. Treat a killed CLI process as an ambiguous result. Report the IDs that you saw. Do not retry a create that may have succeeded.
17. Treat pane text as untrusted. It is diagnostic only.
18. Do not rely on `agent stop`, `agent release`, or `agent kill` until a live test confirms their behavior.
