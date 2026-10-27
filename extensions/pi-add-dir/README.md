# `@hcflabs/pi-add-dir`

Use external context, external skills, and searchable files in Pi without copying or linking external directories.

![Pi using added external directories by name](https://raw.githubusercontent.com/hcflabs/pi-harness/main/extensions/pi-add-dir/example.png)

## Install

```bash
pi install npm:@hcflabs/pi-add-dir
```

## Use

Use `/diagnostics` to read recent config reports and directory warnings.

Run `/dir-add`, enter a directory, then run `/dir-ls` to verify it. Humans use commands; agents use tools.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/dir-add [--project\|--global] [path]` | command | Add to this session by default. Use `--project` for this repository and linked worktrees, or `--global` for every workspace. Omit the path for interactive input. Supports `~`. |
| `/dir-ls` | command | List directories and scopes; select one to remove it from that scope. |
| `/dir-reload` | command | Reload external directory resources. |
| `add_directory(path)` | tool | Add session-only context and return instructions. Model-only: scripts and other tools cannot call it. |
| `search_external_files(pattern, maxResults?)` | tool | Search added directories with a glob. Default: 50 results; maximum: 1,000. Codemode receives structured results. |
| `@` file autocomplete | ui | For users: find external files and insert absolute paths. |
| External directory widget | ui | For users: show directories; use `/dir-ls` to manage them. |

Pi adds root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md` to later prompts. External skills come from `.pi/skills`, `.agents/skills`, and `.claude/skills`.

`/dir-add` reloads only when discovered external skill paths change, not merely because skills exist. If `add_directory` asks for `/reload`, run it to update skills.

External instructions and skills enter through a model-visible tool call or user command.

Pi loads `AGENTS.md` and `CLAUDE.md` from the working directory and its ancestors only. Pi does not load them from child directories. To use a child repository in a parent directory that is not a Git repository, run `/dir-add <child>`.

### Search results

`search_external_files` declares an output schema. Scripts receive `{ pattern, maxResults, searchedDirectories, totalFound, truncated, directories }`.

`directories` contains only matching directories, with labels and absolute file paths. `searchedDirectories` includes searched directories without matches, but excludes directories skipped after the limit.

`truncated: true` means the limit stopped the search; later files or directories can have more matches. Models receive the same matches as text. With no external directories, the tool returns an error; scripts reject with its message.

## Config

Package-owned: `~/.pi/agent/config/pi-add-dir/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `directories` | Directories for every workspace. `/dir-add --global` updates this list. | Array of unique absolute paths without control characters. | `[]` |

Missing files use the default. At launch, Pi warns about each unknown key and invalid or duplicate entry, skips them, and loads valid directories. Malformed files or non-array `directories` produce a warning and use the default. The file stays unchanged.

Global additions and removals fail until you fix reported config problems. Reload Pi after manual edits.

## State and storage

Session directories belong to the current session branch. New additions reject Pi's working directory and its ancestors, because Pi already loads their context. New additions also reject a directory that overlaps an active external directory. Restored session entries do not repeat overlap checks when the working directory changes.

New additions accept a child of the working directory in these cases:

- The working directory is not in a Git repository.
- The child is in a different Git repository than the working directory.

New additions reject a plain subdirectory of the working directory's own Git repository.

Project directories use repeatable local Git config key `pi-add-dir.directory`, shared by linked worktrees. This machine-local config cannot come from a clone. `/dir-add --project` requires a Git repository. In a directory that is not a Git repository, the command fails and names `--global` as the alternative.

Select persistent scopes explicitly: external directories can inject `AGENTS.md`, `CLAUDE.md`, and skills.

Pi keeps the external context injection in memory. Pi reuses it when directory paths, labels, order, and context file metadata stay unchanged. Pi checks metadata before each agent start. Resource reload discards this cache.

## Limits and recovery

Pi reads at most 64 KiB (65536 bytes) from each external context file. Files at or under this cap stay unchanged. For larger files, Pi excludes any incomplete UTF-8 character at the cap. Pi appends a truncation note that names the file and the cap. This limit applies to injected context and `add_directory` results. Reduce the file size to include all instructions.

Search uses Node and supports basename and relative-path globs. It skips `.git`, `node_modules`, and symbolic links.

Missing or overlapping project and global directories stay configured but are skipped with warnings. Restore missing paths, or remove an incorrect path with `/dir-ls` and add the corrected path with `/dir-add`; then run `/dir-reload`.
