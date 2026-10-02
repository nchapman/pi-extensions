# pi-extensions

Personal [pi](https://pi.dev) coding agent extensions. Installed as a local pi package — no build step: change a file, then `/reload` in a pi session.

## Install

```sh
pi install ~/Code/pi-extensions   # one-time; loads in-place
pi list                           # verify
```

## Extensions

| Extension              | What it does                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents.ts`         | Delegate tasks to isolated headless pi runs; slow runs background and wake the agent when done. Also a `bg` tool for shell commands and `/tasks` to manage both.              |
| `recall.ts`            | Lossless search over compacted-away session history (BM25 + local embeddings); owns auto-compaction and summary generation.                                                    |
| `todo.ts`              | Plan tracking that survives compaction, rewind, and resume; progress in tool rows, full-screen `/todos`.                                                                        |
| `overflow.ts`          | Caps oversized custom tool results; full output stashed beside the session.                                                                                                       |
| `openai-gateways.ts`   | Dynamic model discovery for OpenAI-compatible gateways, mirrored into native `models.json` for headless runs.                                                                   |
| `shortcuts.ts`         | Convenience slash commands (`/exit`, `/comp`, `/info`, `/time`); edit `SHORTCUTS` to add your own.                                                                                |

### subagents

Agents are markdown files in `~/.pi/agent/agents/` (YAML frontmatter: `description`, `tools` as string/array/per-tool map, optional `model`/`thinking`). `subagent` runs one task; `subagents` runs a batch in parallel; each agent also gets a `/name` slash command. Pass `agent_md` for an ad-hoc specialist; with neither `agent` nor `agent_md`, a read-only generic investigator runs.

Children are headless pi runs (`pi -p --mode json --no-extensions …`) with isolated context and restricted tools — an unknown tool name is warned and dropped, never a silent widening. Model precedence: the tool call's `model` param → the agent's `model` → the parent chat's current model (children inherit the conversation's model, not pi's global default). Child token usage rides in the tool result, keeping session cost totals accurate.

Slow runs background instead of blocking: after `PI_SUBAGENT_BG_AFTER_MS` (default 2m; `background: true` adopts immediately) the tool returns a task id, and exactly one wake message steers the result in when the child settles (over-cap replies stashed at `<sessionDir>/bg/<id>.txt`). Wakes are real transcript entries, so recall finds them after compaction. `/tasks` lists running tasks; `/tasks kill <id>` (or `kill all`) kills them — the agent has the same lever via `kill_task`. Any `session_shutdown` kills running children.

The same registry also backgrounds shell commands via the `bg` tool: it returns a task id immediately; the wake carries exit status, duration, and a rolling 8KB output tail. `timeout_ms` overrides the 10m SIGKILL default; kills take out the whole process group.

Knobs: `PI_SUBAGENT_TIMEOUT_MS` (default 10m), `PI_SUBAGENT_CONCURRENCY` (default 4), `PI_SUBAGENT_BG_AFTER_MS` (default 2m), `PI_BG_WAKE` (`0` disables wake messages).

### recall

Compaction keeps only a summary in context, but pi stores every raw entry forever — `recall` makes that archive searchable. One tool, two query shapes: `description` (natural language; feeds the embedding model, BM25 as fallback) and `queries` (short exact-term strings you'd grep for — identifiers, paths, error strings; the only thing BM25 sees). `scope: "project"` (default `session`) adds sibling session files, labeled "past session" and down-ranked; `mode: "read"` pages a full entry by ref. Results are verbatim excerpts with provenance; retrieval is always model-initiated, never injected.

Ranking: hand-rolled BM25 over ~3k-char chunks, multiplied by a recency decay (halves per `PI_RECALL_HALF_LIFE_HOURS`, measured from the archive frontier, floored at `PI_RECALL_RECENCY_FLOOR`), fused with the semantic side by weighted RRF (`PI_RECALL_EMBED_WEIGHT`). The semantic side embeds locally with jina-v5-text-nano (ONNX, cached under `~/.pi/agent/models` by a fail-soft `postinstall`) in a disposable worker process; vectors are sign-quantized in a flat append-only file per session dir (`recall-vectors.bin`) — a derived cache, so every failure degrades to lexical-only.

recall also owns the context budget and the summary: auto-compaction fires when projected context exceeds min(`PI_RECALL_COMPACT_TARGET` (256k tokens), `PI_RECALL_COMPACT_RATIO` (0.7) of the model's window), from mid-run `turn_end` drafts and idle `agent_settled`, with pi's near-limit threshold as backstop. Every compaction — manual `/compact` included — is summarized with recall's own prompt: a short map, not the archive (`PI_RECALL_SUMMARY_CHARS`, default 5,000); a substantial partial is salvaged rather than discarded, and deterministic failures fall back to pi's default summarizer. Compaction failures log breadcrumbs to `~/.pi/agent/recall-compaction-errors.log`.

| Knob                        | Default              | Effect                                                                                                    |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `PI_RECALL_SCOPE`           | `session`            | `project` also searches sibling session files                                                             |
| `PI_RECALL_FOREIGN_WEIGHT`  | 0.5                  | Rank weight for past-session chunks                                                                       |
| `PI_RECALL_HALF_LIFE_HOURS` | 4                    | Recency decay half-life from the archive frontier                                                         |
| `PI_RECALL_RECENCY_FLOOR`   | 0.25                 | Minimum recency factor (1 disables decay)                                                                 |
| `PI_RECALL_COMPACT_TARGET`  | 256,000              | Token cap for auto-compaction (0 disables; 10,000,000 = window-relative only)                             |
| `PI_RECALL_COMPACT_RATIO`   | 0.7                  | Also bound the target to this fraction of the model's window                                              |
| `PI_RECALL_COMPACT_OWN`     | on                   | `0` opts out of owning summary generation                                                                 |
| `PI_RECALL_SUMMARY_CHARS`   | 5,000                | Hard character budget for generated summaries                                                             |
| `PI_RECALL_SUMMARY_THINKING`| `off`                | Thinking level for the summary call (`session` mirrors the session's; or a fixed level)                  |
| `PI_RECALL_CHUNK_CHARS`     | 3,000                | Chunk size for indexing                                                                                   |
| `PI_RECALL_SNIPPET_CHARS`   | 400                  | Max chars per result snippet                                                                              |
| `PI_RECALL_MAX_RESULTS`     | 5                    | Max results per search                                                                                    |
| `PI_RECALL_READ_CHARS`      | 4,000                | Max chars per `read` page                                                                                 |
| `PI_RECALL_PROJECT_MAX_MB`  | 64                   | Byte cap for the project corpus                                                                           |
| `PI_RECALL_EMBED`           | on                   | `0` disables the semantic side                                                                            |
| `PI_RECALL_EMBED_DTYPE`     | `q8`                 | ONNX dtype (fp32\|fp16\|q8\|q4\|q4f16)                                                                   |
| `PI_RECALL_EMBED_THREADS`   | all cores            | Cap on onnxruntime's thread pool                                                                          |
| `PI_RECALL_EMBED_WEIGHT`    | 0.15                 | RRF weight of the semantic ranking                                                                        |
| `PI_RECALL_EMBED_MAX_MB`    | 32                   | Byte budget for embedding foreign-session text                                                            |
| `PI_RECALL_MODEL_DIR`       | `~/.pi/agent/models` | Where the ONNX model caches                                                                               |

### todo

One `todo` tool: every call sends the full list (`content` + `status`: pending/in_progress/completed/cancelled, at most one in_progress) and replaces the old one. Invalid lists are rejected with the current state attached so the model self-corrects in one retry; updates that drop unfinished items are accepted with a note naming them. State snapshots ride in tool-result `details` and are replayed on `session_start`/`session_tree`, so every branch, rewind, and resume restores the right list. One-shot reminders re-inject the plan when it is unfinished and stale (4+ turns) or when compaction wiped it; mid-run compaction drafts chain a plan message (`todo.plan`) instead. Call rows show `todo 2/5 — active item`; `/todos` opens the list full-screen.

### overflow

pi truncates its built-in tools, but custom tool results (this package's included) enter context uncapped — a single log dump can cost tens of KB. A `tool_result` handler replaces text over `PI_OVERFLOW_MAX_CHARS` (default 10,000, floor 1,000, `0` disables) with a banner (original/shown/omitted counts) + head (80%) + tail (20%), cut at a line boundary when one sits near the cut. The full output is stashed at `<sessionDir>/overflow/<callId>.txt` — it survives compaction and resume, and the banner points at it. Image parts, `details`, `isError`, and `usage` pass through untouched; built-in tools are skipped by name. Fail-open everywhere: a failed stash write leaves the original result alone — the cap never discards output without a recoverable pointer. Keep `PI_OVERFLOW_MAX_CHARS` above `PI_RECALL_READ_CHARS` if you raise the latter.

### openai-gateways

Registers any OpenAI-compatible gateway (Ollama, vLLM, LM Studio, llamswap, proxies…) with dynamic model discovery via `GET /v1/models` (15s bound). Gateways are configured in `~/.pi/agent/openai-gateways.json` (same name→settings shape as `models.json` providers): per gateway `baseUrl` (required), `apiKey` (default `"local"`), `contextWindow`/`maxTokens` overrides (default 262144/65536), and an optional `models` seed list. On a blip, refresh falls back to the last persisted catalog, then the seeds, and only throws when neither exists; a missing file registers nothing (fail open); unparseable JSON fails loudly at load.

Each gateway is also mirrored into native `~/.pi/agent/models.json` so headless pi runs without extensions — subagent children spawn `pi -p --no-extensions` — can resolve gateway models. The mirror preserves every other key verbatim, never clobbers an unreadable or unparseable file, and writes are tmp+rename atomic and skipped when unchanged.

### shortcuts

A grab bag of convenience slash commands for the things that bug you, because pi ships a fixed command set: a quit family (`/exit`, `/bye`, `/q`, `/close`) that all call `ctx.shutdown()` like `/quit`, a compact family (`/comp`, `/summarize`), plus `/info` (session name, dir, context usage) and `/time` (current date/time). Names avoid pi's built-ins; every handler is wrapped so a throwing shortcut reports via `ctx.ui.notify` instead of crashing.

## Design notes

The through-line: **keep the parent agent's context small** and **fail explicitly**. Each extension adds capability without bloating the tool surface the main agent sees, and every network/child boundary is bounded with actionable errors.

- **subagents**: isolated headless children (no extensions, skills, or context files), fail-closed tool restrictions, model inheritance from the chat, and background wakes that steer in at the next turn boundary — followUp delivery would livelock against sleep-polling models.
- **recall**: the session file is the store (archive = set-diff of branch vs projection — no index files, nothing to invalidate); BM25 first, local sign-quantized embeddings as a disposable cache; compaction owned end to end so the summary stays a map and detail remains re-fetchable.
- **todo**: the plan must outlive the context window — snapshots in tool-result `details`, replayed on every session-tree change.
- **overflow**: the cap must never discard output without a recoverable pointer — fail-open everywhere.
- **MCP**: use pi's built-in (`builtin:mcp`, since 0.99.0) — the old `extensions/mcp.ts` was removed. The `pin: [...]` concept maps to the per-server `exposure` setting in `~/.pi/agent/mcp.json` (`direct` = declared like built-ins; `deferred` = loaded via `tool_search`; default `codemode` = callable from codemode scripts). Manage servers with `/mcp` or `pi mcp add|remove|list|login|logout`.

Full rationale — including the benchmark history behind the embedding model and store-format decisions — lives in [docs/design-notes.md](docs/design-notes.md). Read it before changing any mechanism, and update both it and the relevant section above when behavior changes.

## Development

```sh
npm install            # once
npm run check          # typecheck (lint-grade strict) + full test suite — the gate before every commit
npm test               # vitest only
npx tsc --noEmit       # typecheck only
npm run bench:recall   # retrieval benchmark over a real session dir (spawns the embed worker)
```

Pure logic is exported separately from the extension entries and covered by vitest suites in `tests/` (boundaries injected, no `vi.mock`, no network, no pi launches). The recall benchmark (`scripts/bench-recall.ts`, separate vitest config so `npm test` stays model-free) scores Hit@1/Hit@5/MRR over a snapshotted corpus — `BENCH_SNAPSHOT=1` refreshes the snapshot; `BENCH_DIR` / `BENCH_TARGETS` / `BENCH_CORPUS` / `BENCH_FRESH` tune it; model and format comparison history is in [docs/design-notes.md](docs/design-notes.md).

pi loads the TypeScript directly; the dev dependency on `@earendil-works/pi-coding-agent` (pinned to the installed pi version) provides the types at edit time.
