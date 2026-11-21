# Tools and Commands

Navigation for installed `docs/extensions.md`: read `Tools`, `Tool exposure`,
`Activate tools dynamically`, or `Context and session changes` as needed.
Verify signatures in installed declarations, not this navigation aid.
Example paths below are relative to `examples/extensions/`.

## Select the tool boundary

| Need | Native choice | Reference |
|---|---|---|
| Small model-callable operation | `registerTool`, narrow TypeBox schema (`Type` from `typebox`) | `hello.ts` |
| Data consumed by scripts | `outputSchema` + `structuredContent` | Installed `Tools` section |
| Orchestrate existing tools | `ctx.executeTool()`; list with `ctx.tools`; declare `reachesTools` | Installed `Tools` and `Tool exposure` sections |
| Reduce declarations or discover tools | `exposure`, `namespace` | Installed `Tool exposure` section |
| Deliberate active-set changes | `getActiveTools` / `setActiveTools` | `dynamic-tools.ts`, `tools.ts` |
| Bound large results | Pi truncation helpers | `truncated-tool.ts` |
| Override built-in behavior/rendering | Preserve original contract | `tool-override.ts`, `built-in-tool-renderer.ts` |

- `content` reaches the model; `details` supports rendering/state (use
  `undefined` when absent). For data tools, `structuredContent` must match
  `outputSchema`; scripts receive it rather than text. Redact both channels;
  replacing only `content` in a `tool_result` handler drops structured data.
- Throw for ordinary execution failures. Return `isError: true` when a failure
  must retain structured data. Error-looking text alone is still success.
- Pi 1.3 rejects malformed completed tool-call arguments before execution.
  Use native argument validation; do not execute partially parsed arguments.
  Custom providers and message transforms must preserve `ToolCall.argumentsError`.
- Pi validates tool arguments as JSON Schema with `@earendil-works/pi-schema`.
  Pi first coerces loose values, such as numeric strings. `Type.Refine()`,
  codecs, and `Format.Set()` formats do not apply: check them in `execute()`.
- Nested calls use normal validation/interception but do not add transcript
  entries. Surface needed results in the parent result. Pi aggregates nested
  tool usage; do not count it twice. Report usage for the tool's own model calls.
- Honor cancellation. Use `pi.exec(command, args, { signal })` rather than shell
  assembly. Check `code`, `killed`, and `truncated`. After a signal, `code` is
  128 plus the signal number. `maxBuffer` limits stdout and stderr together.
  Shared in-memory mutation may need sequential execution; file
  read-modify-write needs `withFileMutationQueue()` around the entire operation.
- Use `StringEnum` from `@earendil-works/pi-ai`, not literal unions for Google
  compatibility. Name the tool in each `promptGuidelines` bullet. `StringEnum`
  returns a pi-schema type, so TypeBox `Static` cannot infer it. When you need
  `Static`, use `Type.Unsafe<T>({ type: "string", enum: [...] })`.
- Pi ignores `GrepOperations.readFile`. To search a remote system, override the
  grep tool's `execute()`. `ReadOperations.createReadStream` lets `read` stream.
- Custom renderers must handle partial, absent, error, collapsed, and expanded
  results. `terminate: true` skips follow-up only when the whole batch agrees.

## Exposure before loaders

- `direct`: active tools are declared and callable.
- `model-only`: active tools are declared but cannot be called by other tools;
  use for orchestration or user interaction when appropriate.
- `codemode`: registered tools are callable and listed by codemode, without
  direct declarations unless explicitly activated.
- `deferred`: callable but not listed by codemode; tool search can activate it.
- `hidden`: unreachable; re-register with this exposure to withdraw a tool.

Direct/model-only registration activates the tool; other exposures do not.
Prefer these native policies over a custom discovery loader. When a loader is
required, register candidates first and merge selected names into the current
active set; unknown names are ignored. Changes reach the next model request.
Use `getAllTools()` metadata and `sourceInfo`, not name/path guesses. Tool
annotations are unverified hints, not authorization.

Pi 1.3 restores active tools from the session transcript on resume. A `--tools`
list with only `+name`/`-name` entries modifies that restored selection. Plain
names in `--tools`, `--no-tools`, or `--no-builtin-tools` select tools explicitly
instead. Pi 1.4 also activates an extension tool that the branch never added or
removed, unless the tool registers with `defaultActive: false`. Use native
restoration, not a custom resume hook; keep separate Role or authorization
restrictions.

## Commands and messages

| Need | API | Example |
|---|---|---|
| User-only action; session replacement/reload | `registerCommand` | `reload-runtime.ts` |
| CLI configuration or shortcut | `registerFlag` / `getFlag`, `registerShortcut` | `preset.ts`, `plan-mode/index.ts` |
| Actual user turn | `sendUserMessage` | `send-user-message.ts` |
| Stored model-context message | `sendMessage` | `message-renderer.ts` |
| Durable non-model data | `appendEntry` | `entry-renderer.ts` |
| In-process signal, without persistence/replay | Namespaced `pi.events`; Pi reports a throwing handler as an extension error | `event-bus.ts` |

Validate command arguments; choose message delivery and `triggerTurn`
deliberately. A starting run counts as busy, also during
`before_agent_start`: `ctx.isIdle()` is false, `sendMessage` queues into that
run, and `sendUserMessage` needs `deliverAs`. Session-changing operations are
command-context-only: lifecycle handlers can deadlock. After replacement, use the fresh `withSession` context;
after `await ctx.reload()`, do not reuse the old extension runtime. RPC and SDK
sessions reject `ctx.reload()` while a response or compaction runs: catch it.
`ctx.switchSession()` to a session whose folder is gone asks Continue, Fork, or
Cancel in interactive mode. Handle a cancelled result.
