# 023. Task Profile Models for Runtime Failover

- **Status:** accepted
- **Date:** 2026-10-25

## Context

A Task Profile has a primary Task Route and an optional fallback. In-process consumers use `executeTaskRoutes()`, which tries the fallback when the primary fails. A pi-subagent worker is a separate Pi process. It received one physical model, so a failure on the primary ended the worker turn. The current session agent also had no failover. Pi provides virtual models: a router picks a physical model for each request, and Pi asks the router again before a retry.

## Decision

- `@hcflabs/pi-task-models` registers one virtual model, `task/<profile>`, for each Task Profile. This model is a **Task Profile Model**.
- The router reads the current config for each request. It uses the primary route, then the fallback route after a retryable error. A failed route gets a cooldown of 10 minutes in the process.
- A continuation keeps the previous route, and a context overflow keeps the failed route. This keeps the prompt cache valid.
- A Task Route cannot name a Task Profile Model. Pi does not route a virtual model to another virtual model.
- `extensions/task-profile-models.ts` registers only the Task Profile Models. pi-subagent loads it in a worker and selects `task/<profile>` when the profile has two usable routes. A designated model uses no Task Profile Model.
- The profile config stays the one source of chains. No separate alias config exists.

## Consequences

- Workers and the current session agent fail over on 429, 5xx, overload, network, and timeout errors.
- Pi does not retry other errors, such as 400, 401, 404, or quota errors. These errors still end the turn on the failed route.
- A profile has at most two routes. A longer chain needs a change to the profile config format.
- The worker launch record names the primary route, also when the worker used the fallback.

## Rejected Alternatives

- **A separate alias extension and config file:** it duplicates the profile routes, and each Role must list the extension by path.
- **Gateway fallbacks in the request body:** the LiteLLM `fallbacks` field could not be verified on the gateway. Pi also cannot add body fields to Anthropic Messages requests.
- **A wrapper provider that tries routes inside one request:** it can also catch errors that Pi does not retry. It must reimplement streaming for each API, and is larger than this change.
