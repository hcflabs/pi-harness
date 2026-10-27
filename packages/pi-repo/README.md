# `@hcflabs/pi-repo`

Select a Git repository below a parent directory that is not a Git repository. Validate a `repo` selector, and find the child repositories of a directory.

## Install

```bash
npm install @hcflabs/pi-repo
```

## Use

```ts
import { discoverRepos, resolveRepoTarget } from "@hcflabs/pi-repo";

const found = await discoverRepos("/home/me/code/group");
// found.repos: [{ repo: "ci/components", root: "/home/me/code/group/ci/components", linkedWorktree: false, submodule: false }, ...]

const target = await resolveRepoTarget("/home/me/code/group", "ci/components");
// target.root is the real path of the Git top-level directory.
```

### Repository targets

`resolveRepoTarget(base, repo)` accepts `repo` only when all of these conditions are true:

- `repo` is a relative path without control characters and without a `..` component.
- The real path of `repo` is inside the real path of `base`. A symlink that points outside `base` fails.
- The real path is equal to the Git top-level directory. A subdirectory of a repository fails.

Use `.` to select `base` itself when `base` is a Git top-level directory. The returned `repo` uses the real path, so a symlink selector returns the name of its target.

A bad selector throws `RepoTargetError`. A Git failure throws a plain `Error`, for example a timeout, an ownership error, or malformed output. The package never reports a Git failure as "not a repository".

### Discovery

`discoverRepos(base, options)` searches 3 directory levels below `base` by default. It does these things:

- It searches inside each repository that it finds. It lists a repository inside a repository, for example a submodule.
- It does not follow symlinked directories.
- It skips `.git`, `.worktrees`, `.scratch-*`, `node_modules`, `.terraform`, `venv`, and `.venv`. Add names with `exclude`. The rules apply inside repositories too.
- It checks each `.git` entry with Git. It reports a bad entry in `issues`, and it still searches inside that directory.
- It sets `truncated` when a limit stops the search. The time limit also caps each Git call.
- It sets `truncated` when a directory at `maxDepth` has child directories, because it does not open those children. Raise `maxDepth` to search them.
- Inside a found repository, a directory at `maxDepth` does not set `truncated`. Discovery does not find a repository below `maxDepth` inside another repository.
- It sets `linkedWorktree` when the `.git` file names a `worktrees/` Git directory. It sets `submodule` when the file names a `modules/` Git directory. A repository with a `.git` directory, or with a separate Git directory, has neither flag.

Discovery changes no files and no Git state. It runs one Git process for each `.git` entry that it finds.

| Option | Default | Limit |
| --- | --- | --- |
| `path` | `.` | Relative to `base`, without `..` and without symlinks |
| `maxDepth` | 3 | 1 to 8. The base directory is level 0. |
| `limit` | 200 repositories | 1 to 1 000 |
| `maxDirectories` | 5 000 | 1 to 100 000 |
| `budgetMs` | 30 000 | 1 to 600 000 |
| `timeoutMs` | 10 000 for each Git call | |

### Git root

`gitTopLevel(cwd)` returns the real path of the Git top-level directory that contains `cwd`. It returns `undefined` only when all of these conditions are true:

- Git fails.
- `cwd` and its parents have no `.git` entry.
- A second Git check with `safe.directory=*` finds no Git directory.

Other Git failures throw. A bare repository throws, because it has no work tree. The check does not read Git messages, so the Git language has no effect.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `resolveRepoTarget` | function | Validate one `repo` selector and return its Repository target. |
| `discoverRepos` | function | Find the Git repositories below a directory. |
| `gitTopLevel` | function | Return the real Git top-level directory that contains a path. |
| `isWithin` | function | Return true when a path is a root or a path below it. |
| `RepoTargetError` | class | Identify a bad selector, separate from a Git failure. |
| `RepoTarget` | type | Return `repo`, `root`, and `base`. |
| `RepoDiscovery` | type | Return `repos`, `issues`, and `truncated`. |
| `DiscoveredRepo` | type | Return `repo`, `root`, `linkedWorktree`, and `submodule`. |
| `RepoOptions` | type | Configure the Git runner, cancellation, and Git time limit. |
| `DiscoveryOptions` | type | Configure the search path, depth, and limits. |

`gitTopLevel`, `resolveRepoTarget`, and `discoverRepos` accept `signal` for cancellation and `runProcess` to replace the Git runner in tests.
