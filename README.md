# pi-extensions

Personal [pi](https://pi.dev) coding agent extensions. Loads in-place as a local pi package — edit a file, then `/reload` in a pi session.

Design through-line: keep the parent agent's context small, and fail explicitly.

## Install

```sh
pi install ~/Code/pi-extensions   # one-time
pi list                           # verify
```

## Extensions

| Extension            | What it does                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents.ts`       | Delegate tasks to isolated headless pi runs. Slow runs background and wake the agent when done. Also replaces the built-in `bash` (inline/auto/background) with `task`/`task_kill`/`task_remind` and `/tasks` to manage them. |
| `recall.ts`          | Search compacted-away session history (BM25 + local embeddings). Owns auto-compaction and summary generation.                                                                                                                 |
| `todo.ts`            | Plan tracking that survives compaction, rewind, and resume. Progress in tool rows, full-screen `/todos`.                                                                                                                      |
| `goal.ts`            | A session-scoped goal with a verifiable completion gate: a turn-end check keeps the agent working until it's met, blocked, or a safety cap trips, with a footer showing the objective and elapsed time.                       |
| `overflow.ts`        | Caps oversized custom tool results; full output stashed beside the session.                                                                                                                                                   |
| `openai-gateways.ts` | Dynamic model discovery for OpenAI-compatible gateways, mirrored into native `models.json` for headless runs.                                                                                                                 |
| `shortcuts.ts`       | Extra slash commands (`/exit`, `/comp`, `/info`, `/time`); edit `SHORTCUTS` to add your own.                                                                                                                                  |

### subagents

Agents are markdown files in `~/.pi/agent/agents/` (frontmatter: `description`, `tools` as string/array/per-tool map, optional `model`/`thinking`). `subagent` runs one task; `subagents` runs a batch in parallel; each agent also gets a `/name` slash command. Children are headless pi runs (`pi -p --mode json --no-extensions`) with restricted tools — unknown tool names are dropped, never a silent widening. Model precedence: the tool call's `model` param, then the agent's `model`, then the parent chat's current model.

Runs still in flight after ~2 minutes (or immediately with `background: true`) move to the background: the tool returns a task id and exactly one wake message delivers the result when it settles (over-cap replies stashed at `<sessionDir>/tasks/<id>.txt`). Manage with `/tasks`, `/tasks kill <id>`, `/tasks kill all`, or the `task_kill` tool; peek at a running task with `task <id>` (new output since the last check) or schedule a one-shot check-in with `task_remind` — a single timer that fires once and is dropped if the task already settled, so no turn is burned on silence. `session_shutdown` kills running children.

The extension also replaces the built-in `bash` by name, one tool covering the whole CLI-task lifecycle: `wait: "auto"` (default) blocks up to the same ~2-minute window and then promotes to the background, `wait: "inline"` is the built-in bash verbatim (streaming, truncation, temp-file stashing, structured output), and `wait: "background"` returns a task id immediately. Auto and background run through pi's own local bash operations, so shell resolution, environment, process-tree kill, and exit codes are identical to the built-in. The full output streams to `<sessionDir>/tasks/<id>.log` from byte zero — `task <id>` peeks at it while the command runs and it survives resume — and is removed on kill; the wake carries exit status, duration, and a 4KB output tail. `timeout` is in seconds with no default: 0 or omitted means no timeout. Task ids are `t-` + a base36 timecode, so ids from earlier sessions or parallel sessions never collide in a long-running context.

Knobs: `PI_SUBAGENT_TIMEOUT_MS` (10m), `PI_SUBAGENT_CONCURRENCY` (4), `PI_SUBAGENT_BG_AFTER_MS` (2m), `PI_BASH_BG_AFTER_MS` (2m, the bash auto-promote window), `PI_BG_WAKE=0` to suppress wake messages.

### recall

Compaction keeps only a summary in context, but pi stores every raw entry forever — `recall` makes that archive searchable. One tool, two query shapes: `description` (natural language → embedding model, BM25 as fallback) and `queries` (short exact-term strings → BM25 only). `scope: "project"` also searches sibling session files (labeled, down-ranked); `mode: "read"` pages a full entry by ref.

Ranking is BM25 over ~3k-char chunks, multiplied by a recency decay (halves every 4h from the archive frontier, floored at 0.25), fused with the semantic side by weighted RRF. The semantic side uses a local jina-v5-text-nano ONNX model in a disposable worker process; vectors are sign-quantized in a flat cache file per session dir (`recall-vectors.bin`) — a derived cache, so any failure degrades to lexical-only.

recall also owns auto-compaction: it fires when projected context exceeds min(256k tokens, 70% of the model window), from mid-run `turn_end` drafts and idle `agent_settled`, with pi's near-limit threshold as backstop. Every compaction (including manual `/compact`) is summarized with recall's own prompt — a short map, not an archive, since detail stays re-fetchable. Deterministic failures fall back to pi's default summarizer; compaction failures log to `~/.pi/agent/recall-compaction-errors.log`.

Common knobs (invalid values fall back to defaults with a warning; the full list is in `parseConfig` in `extensions/recall.ts`):

| Knob                        | Default   | Notes                                                |
| --------------------------- | --------- | ---------------------------------------------------- |
| `PI_RECALL_SCOPE`           | `session` | `project` also searches sibling session files        |
| `PI_RECALL_EMBED`           | on        | `0` disables the semantic side                       |
| `PI_RECALL_COMPACT_TARGET`  | 256,000   | Token cap for auto-compaction (`0` disables)         |
| `PI_RECALL_COMPACT_RATIO`   | 0.7       | Also bound the target to this fraction of the window |
| `PI_RECALL_SUMMARY_CHARS`   | 5,000     | Hard budget for generated summaries                  |
| `PI_RECALL_HALF_LIFE_HOURS` | 4         | Recency decay half-life                              |

### todo

One `todo` tool: every call sends the full list (`content` + `status`: pending/in_progress/completed/cancelled, at most one in_progress) and replaces the old one. Invalid lists are rejected with the current state attached; updates that drop unfinished items are accepted with a note naming them. State rides in tool-result `details`, replayed on `session_start`/`session_tree`, so every branch, rewind, and resume restores the right list. Reminders re-inject the plan when it is unfinished and stale (4+ turns) or when compaction wiped it; mid-run compaction drafts chain a `todo.plan` message instead. `/todos` opens the full list.

### goal

A single session-scoped objective with a verifiable completion gate — the agent keeps working turn after turn until the goal is met, blocked, or a safety cap trips, with no user interaction. One tool, `goal`, with an `action` discriminator (`set` | `complete` | `blocked`); it registers inactive and is revealed on the first goal (after-first-goal visibility), so a fresh session adds zero tool surface.

A `verify` command (optional) makes progress measurable: it prints the current state (e.g. a coverage report, a test summary) and exits 0 only when the objective is met. The extension runs it itself in a bounded shell (hard timeout, capped output tail), so the model can't fake success — at completion a failing run is rejected with its output so the real cause gets fixed. No-op verifies (`true`, `:`, `exit 0`) are rejected at `set` time, and a preflight run at `set` reports whether the check already passes. Completion is also a structural gate, not a model self-assessment: to `complete`, the model must supply a `summary` plus `evidence` indexed to the goal's criteria (`evidence[i]` proves `criteria[i]`); a free-text "done" is rejected when it names a failure, a criterion lacks proof, or the id is stale. A semantic second opinion (Jev-style classifier) can slot in behind the injectable `GoalJudge` seam; v1 ships none (fail-open floor).

A `agent_before_settle` loop keeps it working — the "turn-end check": at each settle, an active goal with a `verify` has the check re-run, and the extension queues a hidden follow-up (a `display:false` custom message, so the user sees no "keep going" line) carrying the graded result — the measured state plus either "close these gaps" (check failed) or "summarize and call `complete`" (check passed). Goals without a `verify` are user-driven: the tool tracks the objective and gates completion but does not auto-continue. Two model-untouchable circuit breakers bound a stuck run — a per-session cap on auto-continuations (`PI_GOAL_MAX_CONTINUATIONS`, default 25) and a per-run turn bound (`PI_GOAL_MAX_TURNS_PER_RUN`, default 50) that steers a long turn to settle so the cap can re-engage. At the continuation cap an injectable `ProgressJudge` seam decides whether to keep going: the default judge is deterministic — the verify output changed across the budget window ⇒ still progressing ⇒ the budget resets and the run continues; unchanged ⇒ plateau ⇒ stop — and a no-opinion or throwing judge fails closed to the stop, so the breaker stays the floor. Judge resets are themselves capped (`PI_GOAL_MAX_PROGRESS_RESETS`, default 3) so the judge can't defeat the breaker — the effective worst case any strategy achieves is `PI_GOAL_MAX_CONTINUATIONS × (PI_GOAL_MAX_PROGRESS_RESETS + 1)` continuations, and a verify whose output carries timestamps/timings will read as "progressing" every window, so noisy checks effectively get the full multiple. The judge's evidence is scoped to the current goal (a mid-window re-set clears it) and seeded with the `set`-time baseline; a semantic async (LLM) judge can slot in behind the same awaited seam later. The model's `set`/`complete`/`blocked` never reset any of these; they re-arm only on resume (session start or branch switch — a rewind also re-arms, including after a stop) or a user `/goal` kickoff. A footer status (`🎯 #N: objective · elapsed`) shows the goal and its running time while active and clears on completion or block. A `before_agent_start` reminder re-injects the objective when a compaction hid it (summaries never carry the goal).

State is model-owned and reconstructed from the branch (snapshots in the goal tool result's `details`, replayed on `session_start`/`session_tree`) — no filesystem, nothing desyncs on rewind or resume. `/goal` is a view + kickoff: it shows the goal, starts one (routed through the model so the goal tool creates and persists it), or stops the loop with `/goal stop`.

Knobs: `PI_GOAL_MAX_CONTINUATIONS` (25, per-session settle cap), `PI_GOAL_MAX_TURNS_PER_RUN` (50, per-run turn bound), `PI_GOAL_VERIFY_TIMEOUT_MS` (120,000, verify command timeout).

### overflow

pi caps its built-in tools, but custom tool results enter context uncapped — a `tool_result` handler replaces text over `PI_OVERFLOW_MAX_CHARS` (default 10,000, floor 1,000, `0` disables) with a banner + head (80%) + tail (20%), stashing the full output at `<sessionDir>/overflow/<callId>.txt`. Images, `details`, `isError`, and `usage` pass through; built-in tools are skipped. Fail-open: a failed stash write leaves the original result intact — the cap never discards output without a recoverable pointer. Keep `PI_OVERFLOW_MAX_CHARS` above `PI_RECALL_READ_CHARS` if you raise the latter.

### openai-gateways

Registers OpenAI-compatible gateways (Ollama, vLLM, LM Studio, llamswap, proxies…) with live model discovery from `GET /v1/models`. Config: `~/.pi/agent/openai-gateways.json` — per gateway, `baseUrl` (required), `apiKey` (default `"local"`), `contextWindow`/`maxTokens` overrides (262144/65536), and an optional `models` seed list. Each gateway is mirrored into native `~/.pi/agent/models.json` so extension-less headless runs (subagent children) can resolve its models. Fail-soft: blips fall back to the last persisted catalog, then seeds; a missing file registers nothing; unparseable JSON fails loudly at load.

### shortcuts

A quit family (`/exit`, `/bye`, `/q`, `/close` → `ctx.shutdown()`), a compact family (`/comp`, `/summarize`), plus `/info` (session name, dir, context usage) and `/time`. Edit the `SHORTCUTS` array to add your own.

## Development

```sh
npm run check         # typecheck (lint-grade strict) + full test suite — the gate before every commit
npm test              # vitest only
npm run bench:recall  # retrieval benchmark over a real session dir (spawns the embed worker)
```

Pure logic is exported separately and covered by `tests/` — boundaries are injected as fakes, no `vi.mock`, no network, no pi launches. pi loads the TypeScript directly; the dev dependency on `@earendil-works/pi-coding-agent` (pinned to the installed pi version) provides types at edit time.

MCP: use pi's built-in (`builtin:mcp`, since 0.99.0) — the old `mcp.ts` was removed. Per-server `exposure` in `~/.pi/agent/mcp.json` (`direct` / `deferred` / `codemode`) covers the old `pin` concept; manage servers with `/mcp`.
