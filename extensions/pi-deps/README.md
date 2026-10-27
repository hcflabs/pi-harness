# `@hcflabs/pi-deps`

Start locked Node and uv dependency installs when Git creates a worktree in an opted-in repository. See [the hook design decision](./docs/adr/0001-prepare-dependencies-at-worktree-creation.md).

## Install

```bash
pi install npm:@hcflabs/pi-deps
```

## Use

Run `/deps` in a trusted repository. Create a worktree through Git, then open Pi there in TUI mode to see install progress.

If Pi runs in a parent directory that is not a Git repository, run `/deps <repo>`. See [Parent directory](#parent-directory).

| Surface | Type | Purpose |
| --- | --- | --- |
| `/deps [repo]` | command | For humans: enable or disable dependency preparation for future worktrees. Works from any worktree in the repository. Needs `repo` in a parent directory. |
| Pi footer status | ui | For TUI users: show a dim spinner and elapsed install time, without command output. Success clears it silently; failures show errors and log paths. |

The shared `post-checkout` hook applies to every worktree. The extension never overwrites or removes hooks without its marker.

After package updates, run `/deps` twice in each opted-in repository to replace the copied hook.

### Parent directory

`repo` is a path relative to the Pi working directory. It must name the top-level directory of a Git repository. A path with `..`, an absolute path, a path that leaves the working directory, and a subdirectory of a repository fail with a message. A repository path also works inside a repository.

`/deps` without `repo` in a parent directory changes nothing. It fails, names the `repo` argument, and lists up to 10 repos that it found below the working directory. The search has limits for depth, directory count, and time. The message says when more repos may exist.

A session in a parent directory has no Git directory. It watches no install at start. When `/deps <repo>` enables a repo in such a session, Pi reads the status file in the Git directory of that repo one time. If an install is running, Pi shows the progress until it ends. If there is no status file, the watch ends.

The watch covers only the selected checkout. It does not cover a worktree that Git creates later, because that worktree has its own Git directory. Open Pi in the new worktree to see its progress. A session that starts in a repository keeps watching its own checkout when you run `/deps <repo>`.

## Flow

![Dependency preparation with validation, an install-needed decision, and selected detached installs](./docs/dependency-preparation-flow.svg)

Synchronous lockfile validation immediately fails the worktree command for conflicting Node lockfiles, mismatched `packageManager`, and unsupported declarations.

After validation, detached frozen installs run. Node and uv both run when both lockfile types exist. Worktree creation and Pi startup do not wait: dependencies can still be unavailable when you use the worktree.

Only tools that run `post-checkout` prepare dependencies. `git worktree add --no-checkout` does not; `git worktree add --detach` with checkout does.

## State and storage

Results go to `<worktree gitdir>/pi-deps/status.json`; command output goes to adjacent `install.log`.

The first Pi TUI session to report the result removes the status file. RPC, JSON, and print sessions neither show nor consume it. Non-Pi consumers must read it themselves.

## Limits and recovery

Dependency installation can execute repository-controlled build and install scripts. Enable only repositories that you trust.

`/deps` refuses a configured `core.hooksPath` that replaces the shared hooks directory, where Git could ignore or share the hook.

Only Git-root lockfiles count. Package managers handle root npm and uv workspaces; Pi Deps does not scan nested independent projects.

| Existing path | Install skipped |
| --- | --- |
| `node_modules` | Node |
| `.pnp.cjs` | Yarn only |
| `.venv` | uv |

After ten minutes of `running` status, the TUI watcher removes the status file, clears the footer, and reports an error with the log path. It stops watching, not the installer. Opening Pi again cannot restore removed status.

If the watcher cannot read the status file, it stops and shows one warning with the file path and the error code. A file that is not valid JSON gets three reads before the watcher stops, because the installer can be in the middle of a write. Other read errors, such as `EACCES` or `EISDIR`, stop the watcher at once. The watcher keeps the file, so each new session shows the warning again. Examine the file, then remove it.

Closing Pi stops its watcher and animation, but does not cancel the installer or consume its pending result.

For failures, including missing executables, examine `<worktree gitdir>/pi-deps/install.log` for command output and `pi-deps:` messages. The log remains after status removal.

### Package managers

The root lockfile selects the command. A matching `packageManager` uses that command for all declared versions; the hook does not compare installed executable versions.

Explicit `yarn@1.x` fails immediately. With only `yarn.lock` and no `packageManager`, the hook assumes modern Yarn; a Yarn Classic executable fails in the background.

| Manager | Command | Lockfile |
| --- | --- | --- |
| npm | `npm ci` | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` |
| Yarn | `yarn install --immutable` | `yarn.lock` (no support for Yarn Classic 1.x) |
| Bun | `bun install --frozen-lockfile` | `bun.lock`, `bun.lockb` |
| uv | `uv sync --locked` | `uv.lock` |
