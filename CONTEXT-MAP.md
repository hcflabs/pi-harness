# Context Map

Each context defines package-specific language and its boundary. Contexts are added only when source or documentation supports concrete domain terms; shared implementation mechanics alone do not need a glossary.

## Active contexts

| Context | Domain glossary | Scope |
| --- | --- | --- |
| `pi-add-dir` | [Pi Add Dir](extensions/pi-add-dir/CONTEXT.md) | External instructions, Skills, file search, and directory scope |
| `pi-advisor` | [Pi Advisor](extensions/pi-advisor/CONTEXT.md) | Opt-in second-model Review of a settled Run, graded Notes, and one Blocker Follow-up |
| `pi-ask-question` | [Pi Ask Question](extensions/pi-ask-question/CONTEXT.md) | Explicit predefined or custom user answers |
| `pi-auto-compact` | [Pi Auto Compact](extensions/pi-auto-compact/CONTEXT.md) | Read trim, summary compaction, and emergency task resumption |
| `pi-codegraph` | [Pi CodeGraph](extensions/pi-codegraph/CONTEXT.md) | Separate checkout indexes, seed indexes, and indexing consent |
| `pi-config-store` | [Pi Config Store](packages/pi-config-store/CONTEXT.md) | Extension Config Homes, config issues, and safe replacement |
| `pi-deps` | [Pi Deps](extensions/pi-deps/CONTEXT.md) | Repository opt-in and dependency preparation for new worktrees |
| `pi-footer` | [Pi Footer](extensions/pi-footer/CONTEXT.md) | Checkout identity, usage, work time, status, and opening the current directory |
| `pi-goal` | [Pi Goal](extensions/pi-goal/CONTEXT.md) | Branch-derived Goals, Evidence-based completion, Continuation limits, and Budget |
| `pi-herdr` | [Pi Herdr](packages/pi-herdr/CONTEXT.md) | Herdr panes, Pi-agent launches, and shell readiness |
| `pi-herdr-tools` | [Pi Herdr Tools](extensions/pi-herdr-tools/CONTEXT.md) | Conversation clones, handoffs, side questions, titles, and worktree completion |
| `pi-memory` | [Pi Memory](extensions/pi-memory/CONTEXT.md) | Durable cross-session facts, candidate review, and approved rule promotion |
| `pi-notes` | [Pi Notes](extensions/pi-notes/CONTEXT.md) | User reminders owned by one Git worktree instance |
| `pi-prompt-creator` | [Pi Prompt Creator](extensions/pi-prompt-creator/CONTEXT.md) | Conversation signals, prompt candidates, review, and approved prompt creation |
| `pi-repo` | [Pi Repo](packages/pi-repo/CONTEXT.md) | Repository targets, selectors, and bounded child repository discovery |
| `pi-session-recall` | [Pi Session Recall](extensions/pi-session-recall/CONTEXT.md) | Saved conversation evidence, branch-aware retrieval, and independent mining examples |
| `pi-subagent` | [Pi Subagent](extensions/pi-subagent/CONTEXT.md) | Role delegation, shared-checkout admission, and checked isolated integration |
| `pi-task-models` | [Pi Task Models](extensions/pi-task-models/CONTEXT.md) | Consumer-owned Model Tasks, shared routes, assignments, and presets |
| `pi-undo` | [Pi Undo](extensions/pi-undo/CONTEXT.md) | Conversation rewind without filesystem rollback |

`pi-process` supplies general bounded process execution. It does not need a separate domain glossary.

## Relationships

Arrows mean that the first context uses a capability owned by the second, unless the row states a display or scope relationship.

| Contexts | Boundary and evidence |
| --- | --- |
| `pi-advisor`, `pi-auto-compact`, `pi-herdr-tools`, `pi-memory`, `pi-prompt-creator`, `pi-subagent` → `pi-task-models` | Consumers declare their own Model Tasks and use shared Task Profiles. Pi remains the model authority; see [ADR 017](docs/adr/017-consumer-owned-task-model-routing.md). |
| `pi-prompt-creator` → `pi-subagent` | Prompt analysis uses the bounded executor for a tool-free child, not a Role changeset; see [prompt analysis](extensions/pi-prompt-creator/README.md#analysis). |
| `pi-herdr-tools`, `pi-subagent` → `pi-herdr` | The shared package supplies Herdr access. Consumers retain conversation and worker workflow ownership; see [ADR 002](docs/adr/002-shared-herdr-cli-client.md). |
| `pi-memory` → `pi-ask-question` | Memory conflict resolution uses the shared question UI; see [candidate review](extensions/pi-memory/README.md#candidate-review). |
| `pi-footer` ← `pi-codegraph`, `pi-subagent` | The footer displays index status and counts completed subagent usage. It does not own those workflows; see [footer display](extensions/pi-footer/README.md#use). |
| `pi-memory` ← `pi-herdr-tools` | Memory recognizes side-thread children to omit parent-only injection; see the [Memory](extensions/pi-memory/README.md#works-with) guidance. |
| `pi-goal`, `pi-auto-compact` | Both handle Pi's final-settlement boundary. Each keeps earlier boundary entries; Pi Goal yields when another handler already continues. See [Pi Goal flow](extensions/pi-goal/README.md#flow). |
| `pi-advisor` ← `pi-goal`, `pi-auto-compact` | Pi Advisor reviews a Run only after Pi settles it, so boundary continuations by these extensions stay in the reviewed Run. It starts at most one follow-up Run for each user prompt. See [Pi Advisor flow](extensions/pi-advisor/README.md#flow). |
| Config-owning extensions → `pi-config-store` | Shared loading and reporting enforce safe config rules; each extension owns its schema, generated state, and home. Consumers use owner APIs or events, not direct cross-owner file access; see [ADR 004](docs/adr/004-extension-config-safety.md) and [ADR 018](docs/adr/018-extension-config-homes.md). |

Scope boundaries also matter:

- `pi-memory` keeps curated cross-session facts; `pi-session-recall` retrieves historical evidence; `pi-notes` keeps user reminders for one worktree. These are not interchangeable stores. See [ADR 005](docs/adr/005-knowledge-tier-model.md).
- `pi-herdr-tools` manages human-directed conversations and worktree completion; `pi-subagent` owns checked delegation and integration. A side-thread merge is text delivery, not a Git merge. See [ADR 019](docs/adr/019-pi-subagent-orchestration.md) and [ADR 021](docs/adr/021-herdr-workflow-consolidation.md).
- `pi-deps` prepares dependencies when Git creates an opted-in worktree; `pi-codegraph` prepares indexes when Pi starts. One does not prove the other is ready. See [dependency preparation](extensions/pi-deps/README.md#flow) and [index setup](extensions/pi-codegraph/README.md#flow).
- `pi-auto-compact` reduces active model context; `pi-prompt-creator` analyzes effective retained context; `pi-undo` rewinds a conversation branch. None of these operations restores filesystem changes. A `pi-undo` rewind also removes `pi-goal` records after the rewind point, because `pi-goal` reads its Goal from the branch.
