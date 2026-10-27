# Pi Repo

Pi Repo selects Git repositories below a base directory, which is usually the working directory of Pi. It does not own admission, Herdr workspaces, or integration policy. See [ADR 022](../../docs/adr/022-multi-repo-targets-and-command-panes.md).

## Language

**Base directory**:
The directory that a selector is relative to. It can be outside Git.
_Avoid_: root, workspace

**Repository target**:
A Git top-level directory inside the base directory, selected with a `repo` selector.
_Avoid_: child checkout, project

**Selector**:
A relative path from the base directory to a Repository target, with `/` separators. `.` selects the base directory.
_Avoid_: repository name, Herdr ID

**Canonical root**:
The real path of a Git top-level directory after symlink resolution.
_Avoid_: repository key

**Discovery**:
A bounded, read-only search for Repository targets below a directory. It also searches inside a repository that it found, for example for submodules.
_Avoid_: scan, crawl
