# `@hcflabs/pi-herdr-tools`

Clone conversations, hand off tasks, and ask side questions in Herdr. Name conversations, see where idle conversations stopped, and finish worktrees with explicit safety checks.

## Install

```sh
pi install npm:@hcflabs/pi-task-models
pi install npm:@hcflabs/pi-herdr-tools
```

Use Herdr 0.9.3 or later in a Herdr-managed Pi pane. Outside Herdr, rename still sets the Pi session title.

Configure `fast` in `/task-models`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@hcflabs/pi-herdr`](https://github.com/hcflabs/pi-harness/tree/main/packages/pi-herdr) | Required | Herdr CLI access. |
| [`@hcflabs/pi-process`](https://github.com/hcflabs/pi-harness/tree/main/packages/pi-process) | Required | Process-lease checks for command panes. |
| [`@hcflabs/pi-repo`](https://github.com/hcflabs/pi-harness/tree/main/packages/pi-repo) | Required | Repository target validation for handoffs and command panes. |
| [`@hcflabs/pi-memory`](https://github.com/hcflabs/pi-harness/tree/main/extensions/pi-memory) | Improves | Keeps Main-only memory and dream advice out of side threads. |
| [`@hcflabs/pi-task-models`](https://github.com/hcflabs/pi-harness/tree/main/extensions/pi-task-models) | Required | Model profiles for titles, idle recaps, and side threads. |

## Use

Use `/diagnostics` to read recent config reports and command recovery errors.

Run `/clone-tab`; the original session stays active. Commands and prompts are for humans; tools are for agents.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/clone-tab` | command | Clone into a new tab in the current workspace. |
| `/clone-worktree` | command | Clone into a new Git worktree workspace. |
| `/handoff-worktree <issue>` | prompt | Prepare a task for `herdr_handoff`. |
| `herdr_handoff` | tool | Start a separate task from local `main`, without changing focus. |
| `herdr_command` | tool | Run a long command in a new pane, read its output and saved exit status, and stop it. Main only. |
| `/done [-f]` | command | Remove the worktree and close its workspace tabs. `--force` aliases `-f`. |
| `/btw [<question...>]` | command | Open a side pane with an optional editable draft. |
| `/btw ask <question...>` | command | Ask a question starting with a subcommand name. |
| `/btw config [option value]` | command | Show values or `reset` defaults. Set `auto-submit` to `on`/`off`, `tools` to `inherit`/`all`/`read-only`/`none`, or `split` to `right`/`down`. |
| `/btw merge [<prompt...>]` | command | Queue a merge request. Without a prompt, open the editor. In Main, check pending deliveries. |
| `/btw help` | command | Show command grammar. |
| BTW capability widget | ui | Show `tool-free`, `read-only`, `tool-enabled`, or context-load errors with recovery steps. |
| `/rename` | command | Generate a title from up to five recent user messages. |
| Rename progress and result widgets | ui | Show `renaming...`, then `renamed to <title>` for two seconds on success. |
| First real user prompt | ui | Start titles in new, untitled conversations. |
| `pi-herdr-rename/rename` | model task | Title model profile. |
| Idle recap widget | ui | Show the goal, current state, and next action after four idle minutes. |
| `pi-herdr-tools/recap` | model task | Idle recap model profile. |
| `pi-herdr-btw/btw` | model task | Side-thread model profile. |
| Dialog blocked status | ui | Show `Input required` in Herdr during interactive TUI dialogs. |

### Clones

Both commands require `HERDR_ENV=1` and `HERDR_PANE_ID`. Pane, session-path, and leaf validation precedes target creation. Clones contain the root-to-current-leaf path, excluding sibling branches and still-streaming assistant output. Unsaved sessions use live state.

![Clone launch and recovery boundaries.](./docs/clone-flow.svg)

Clone tabs keep the current working directory. Worktree clones use the new checkout. Pi starts with `--session <absolute-clone-file>`; only successful launches change focus.

Worktree creation uses `herdr worktree create --workspace <current-workspace> --no-focus`, or the repository's parent workspace when already in a linked worktree. Herdr creates missing branches from `HEAD`, with checkouts under `worktrees.directory` in grouped workspaces. Clones and handoffs use an extra unfocused tab if a layout plugin such as `herdr-plus` occupies the root pane.

### Worktree handoff

Run `/handoff-worktree Fix the flaky login test`. The agent collects missing facts, asking one question only for an unclear repository, outcome, or critical constraint. It sends a self-contained prompt, not the conversation, and reports without waiting for completion.

The tool registers only with `HERDR_ENV=1`. It also requires `HERDR_PANE_ID` and local `main`. A handoff has no checked integration: the new agent works without supervision. Delegated subagents cannot use the tool.

The tool selects the repository in one of two ways:

- Without `repo`, the current directory and the pane workspace must be in the same Git repository.
- With `repo`, the tool uses that child repository of the Pi working directory. Use it when Pi runs in a parent directory that holds many repositories. The current workspace does not need a Git checkout.

The tool never selects a child repository automatically. All parameters must be non-empty strings:

| Parameter | Requirement |
| --- | --- |
| `branch` | New branch; must not exist. |
| `label` | Workspace label. |
| `agentName` | Unique agent name matching `^[a-z][a-z0-9_-]{0,31}$`. |
| `prompt` | Self-contained task prompt. |
| `repo` | Optional. A Git top-level directory, relative to the Pi working directory. It must not contain `..` or resolve outside that directory. A subdirectory of a repository fails. |

After validation, the tool runs `herdr worktree create --workspace <parent> --branch <branch> --base main --label <label> --no-focus`. With `repo`, it uses `--cwd <repository>` instead of `--workspace <parent>`. Herdr then opens the primary workspace of the repository, or creates it, and does not close it later. It starts Pi without session arguments. It submits `herdr agent prompt <agentName> <prompt> --wait --until working --timeout 30000`, with the prompt as one argument, not a shell command or file. The result includes workspace ID, tab, pane, branch, checkout path, agent name, and `repo` when set.

### Command panes

Main uses `herdr_command` for a command that runs longer than a tool call should wait, such as a full test suite or a build. The tool registers only with `HERDR_ENV=1`.

| Action | Fields | Result |
| --- | --- | --- |
| `start` | `command`, `access`, and optional `args`, `repo`, and `cwd` | Opens an unfocused split of Main's pane and returns a job ID at once. |
| `read` | `id`, optional `lines` | Shows the recent pane output and the saved process status. It never waits. |
| `stop` | `id` | Stops the job processes, closes the job pane, and proves the end. |

`command` is one executable and `args` is its argument list. No shell parses them. To use a shell, name the shell, for example `bash` with `["-lc", "make test"]`. `repo` selects a child repository of the Pi working directory. `cwd` selects a directory inside `repo`, or inside the Pi working directory without `repo`.

A small runner script starts the command without a shell and saves its exit code or signal in a private file. Pane output is untrusted terminal text. The tool never reads the exit status from the screen, because a command can print any text.

Set `access` to `write` when the command can change files, Git state, or external resources. A write job blocks direct `pi-subagent` writers in its checkout until `stop` proves that the job ended. Nothing enforces `read`.

`stop` signals the processes that hold the job's private lease file, and the job's process group. It then closes only the job pane and requires two empty `lsof` scans of the lease and an empty process group. The proof does not cover a process that leaves the group and closes the lease. Examples are a daemon, a `sudo` or `ssh` session, and a container. `read` and `stop` check the pane's terminal identity, so they never act on a later pane with the same ID.

Session shutdown stops each job in the same way. If a stop cannot prove the end, the next session restores the job and its write activity, so `stop` can try again. Delegated subagents cannot use the tool.

The tool is not a sandbox. It does not authorize a push, a publication, a deployment, or the use of credentials. It does not hide secrets that a command prints.

### Side questions

With a conversation open, run `/btw Why is this test failing?`, then submit the draft. Exact first words `ask`, `config`, `merge`, and `help` select subcommands; other input is a question.

The side-thread model receives Main's fixed, compaction-aware context snapshot. Enabled tools can change shared files. Select `read-only` or `none` to prevent changes. Shorten Main's context if it exceeds the side-thread context limit.

![Side-thread merge delivery.](./docs/btw-merge-sequence.svg)

Run `/btw merge Apply the smallest safe fix` after the answer. The merge request contains user and assistant text, without tool payloads. Pending delivery survives shutdown until consumption or 24-hour stale cleanup. Once idle and authenticated, Main appends the transcript without starting a turn, then submits the prompt.

### Titles

Automatic titles ignore extension-injected, empty, and image-only prompts. Expanded skill and prompt-template text starts background generation without delaying the reply. English, sentence-case display titles usually have two or three words; limits are four words and 20 characters.

Herdr updates the pane and sole-pane tab. Linked worktrees get semantic branches only for detached checkouts or generated `worktree/...` branches; other branches remain unchanged. For example, `Update task logic` gives `refactor/update-task-logic`. Generated worktree labels change automatically; manual `/rename` can replace custom workspace names.

### Idle recaps

When an agent run settles, a four-minute idle timer starts. Then the recap model reads the user and assistant text and the newest compaction or branch summary of the current branch, without tool payloads. The recap request has a limit of 48 KiB, so Pi keeps the start of the summary and the newest turns. It writes an idle recap of at most 40 words. The widget above the editor shows `↺ Recap: <text>`. The recap does not go into the model context.

Idle recaps require an interactive UI. Pi does not start the timer when the editor has text. In the TUI, a key press stops the timer and cancels a recap request. Submitted input, `!` shell commands, a new agent run, tree navigation, `/reload`, session switch, and exit also remove the widget. Without new entries on the branch since the last recap, Pi does not make a new recap.

### Dialog status

Status requires Herdr's installed Pi integration, `~/.pi/agent/extensions/herdr-agent-state.ts`. Select, confirm, input, editor, and custom dialogs from any package count; RPC, JSON, and print modes do not. No dialog title or content goes to Herdr.

Status clears on answer, cancellation, failure, `/reload`, session switch, or exit. Reload can hide dialogs; late events cannot restore status. Nested dialogs count as one block. Other status owners, including `@hcflabs/pi-ask-question`, remain independent.

## Flow

### Worktree completion

![Worktree removal and primary-checkout update.](./docs/done-flow.svg)

`/done` requires `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_TAB_ID`. Commit or discard changes, then confirm removal; declining changes nothing. Normal and forced completion wait for idle Pi.

`/done` gets the checkout from the Herdr workspace of the current pane, not from the Pi working directory. Pi can run in a subdirectory of the checkout. `/done` refuses a workspace that is not a linked Git worktree, and it then changes nothing.

Normal removal rejects dirty worktrees and checkout use by other workspaces. Close listed tabs and retry; labels identify them, or IDs without labels. Primary-checkout tabs do not block removal or updates.

**`/done -f` skips confirmation and cross-workspace checks. It passes `--force` to Git, can permanently delete uncommitted work, and can leave other workspaces' tabs pointing at a removed checkout.**

Cleanup runs `git worktree remove <checkout>`, closes other tabs in the current workspace, then updates a non-bare primary checkout with `git pull --ff-only`. The current tab closes last, even if the update fails. Tabs in other workspaces do not close.

## Config

Package-owned: `~/.pi/agent/config/pi-herdr-btw/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `autoSubmit` | Submit the draft automatically; otherwise, keep it editable. | Boolean. | `false` |
| `tools` | Tools available in the side pane. | `inherit` (Main's active tools), `all`, `read-only` (built-in read-only tools), or `none`. | `inherit` |
| `split` | Side-pane placement. | `right` or `down`. | `right` |

File and fields are optional. Launch reports unknown keys and invalid values, using field defaults; malformed files use all defaults. `/btw` continues without changing the file. `/btw config show` prints effective values. Updates fail until you correct issues or run `/btw config reset`. Reset reports issues, then replaces the file with defaults.

Package-owned: `~/.pi/agent/config/pi-herdr-tools/config.json`, key `commandPane`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `split` | Command-pane placement. | `right` or `down`. | `right` |
| `maxActive` | Jobs that are not stopped, at one time. | 1 to 16. | `4` |
| `maxRuntimeMinutes` | Run time before the runner stops the command with `SIGTERM`, then `SIGKILL` after 10 seconds. | 1 to 1440. | `120` |
| `readLines` | Default line count for `read`. | 1 to 1000. | `200` |
| `maxReadBytes` | Output bytes that `read` returns. | 1024 to 65536. | `32768` |

An invalid value warns and uses its default. No value removes a limit. A malformed file blocks `start` until you correct it.

### Model profiles

See [`@hcflabs/pi-task-models`](https://github.com/hcflabs/pi-harness/tree/main/extensions/pi-task-models) for profile defaults, assignments, and config errors.

Side threads select the first authenticated viable route before launch. Titles use the primary route, then fallback, with configured thinking; they never substitute the current session model. An invalid title gets one repair request before fallback. Without a viable route, titles remain unchanged. Idle recaps use the same route order and never substitute the current session model.

## State and storage

Each `herdr_command` job keeps its launch record, saved status, and lease file in `~/.pi/agent/config/pi-herdr-tools/commands/<id>/`. A proved stop removes that directory. A new session restores each job whose pane or leased processes remain, and it never restarts a command.

Clones are separate session files in the Pi-selected session directory. Each contains only the active path. Pi names the clone file for a saved source session; otherwise, the extension creates and names it. Saved `pi-herdr-rename/title` entries restore display titles and semantic branches without another model request. Older titles get no migration.

## Limits and recovery

| Failure | Recovery |
| --- | --- |
| Definite clone-tab creation failure | The clone file is removed. Cleanup errors name any remaining file. |
| Worktree creation or pre-launch extra-tab failure | No clone session exists yet. |
| Killed or incomplete worktree creation | Partial workspace state can remain. Inspect returned IDs with `herdr workspace list`. |
| Incomplete tab response | Inspect known IDs before cleanup. Clone tabs retain the session path; worktree clones retain the worktree without a clone session. |
| Agent start requested | An ambiguous launch retains targets and session files. Inspect reported IDs. |
| Clone focus failure | Pi already started. Focus its tab manually. |
| Handoff validation failure | No worktree exists. Correct the reported requirement. |
| Handoff cancellation | Before creation, nothing remains. After creation, reported resources remain; later launch or delivery steps stop. |
| Handoff start or prompt failure | Resources remain. Errors identify worktree, branch, workspace, tab, pane, and agent. No automatic cleanup occurs. |
| `agent_blocked` or `agent_prompt_stalled` | Prompt delivery failed. Inspect the agent before retrying. |
| `herdr_command` start before the command runs | The tool closes its pane and ends its write activity. Nothing ran. |
| `herdr_command` start with an unconfirmed `pane run` | The job and its write activity remain. Use `read`, then `stop`. |
| `herdr_command` stop that cannot prove the end | The job, its write activity, and its evidence in `config/pi-herdr-tools/commands/<id>/` remain. Stop the reported processes, then call `stop` again. |

Timed-out prompts can still arrive. Check `herdr agent get` and `herdr agent read`; resend with `herdr agent prompt` only if absent. Alternatively, run `/done` in the new worktree. Remove personal `handoff-worktree.md` copies to resolve package-prompt name collisions.

After a failed primary update, the removed worktree stays removed. Correct primary-checkout changes or divergence, then run `git -C <primary-checkout> pull --ff-only`.

`/rename` warns without user text. For Herdr or Git synchronization warnings, correct the problem and retry `/rename`. Newer renames silently cancel older requests.

When an idle recap request fails, Pi shows a warning and does not retry. Pi shows each different warning only one time. The next settled run starts a new idle timer.
