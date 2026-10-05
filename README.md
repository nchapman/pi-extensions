# pi-extensions

A personal collection of [pi](https://pi.dev) coding-agent extensions. The common idea is to give an agent useful long-running capabilities while keeping its everyday context and tool surface small: work can be recovered, checked, or delegated without silently losing state.

## Install

Install the package once, then reload pi after editing the files:

```sh
pi install ~/Code/pi-extensions
pi list                       # verify the package is installed
```

Pi loads the TypeScript in this directory directly; there is no build step. The package registers the `extensions/` directory, so pi loads all included extension files. `recall` imports plan-rendering code from `todo`, so keep both if packaging extensions selectively.

## Extensions at a glance

| Extension                                          | Adds                                                                               | Useful for                                                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`subagents`](extensions/subagents.ts)             | `subagent`, `subagents`, background-task tools, `/tasks`, and named agent commands | Delegating work or running shell commands without losing track of them. Blocking is the default; opt into background work when it helps. It also replaces pi's `bash` tool with a compatible inline mode and optional background modes. |
| [`recall`](extensions/recall.ts)                   | `recall`                                                                           | Finding details from earlier in the session after compaction. Searches archived turns with lexical ranking and optional local semantic search; also manages context compaction and summaries.                                           |
| [`todo`](extensions/todo.ts)                       | `todo`, `/todos`                                                                   | Keeping a multi-step plan visible and recoverable across compaction, rewind, and resume. The agent replaces the complete list on each update.                                                                                           |
| [`goal`](extensions/goal.ts)                       | `goal`, `/goal`                                                                    | Pursuing one high-level objective with per-criterion evidence required at completion. An optional verification command can drive an automatic work/check loop, bounded by continuation and turn limits.                                 |
| [`overflow`](extensions/overflow.ts)               | —                                                                                  | Preventing large custom-tool results from crowding out useful context. Oversized text is capped and the full result is saved beside the session for recovery.                                                                           |
| [`openai-gateways`](extensions/openai-gateways.ts) | OpenAI-compatible providers                                                        | Discovering models from local gateways and proxies such as Ollama, vLLM, or LM Studio, including for headless subagent runs.                                                                                                            |
| [`shortcuts`](extensions/shortcuts.ts)             | `/exit`, `/bye`, `/q`, `/close`, `/comp`, `/summarize`, `/info`, `/time`           | Common command aliases and quick session information.                                                                                                                                                                                   |

## Plans, goals, and memory

These three extensions solve different problems:

- **`todo` is a plan.** Use it to track steps, status, and progress. Its state follows the active session branch, and `/todos` opens the full list.
- **`goal` is a commitment.** Use it for a larger objective. Add a `verify` command that reports the measured state and exits successfully only when the goal is met; the extension runs it, requires it to pass before completion, and continues the agent while it fails. Passing the check does not complete the goal automatically: the agent must still call `complete`. Completion also requires a summary and evidence text for every criterion, but that text is not independently validated (no semantic judge ships). Without `verify`, the goal is user-driven and does not auto-continue. `/goal <objective>` starts one, `/goal` shows status, `/goal pause` and `/goal resume` suspend and continue the pursuit, and `/goal stop` halts the loop. Pause and stop are session-scoped, not saved to the branch; reloading can re-adopt the last saved active goal.
- **`recall` is searchable history.** Ask it to find earlier decisions or details that compaction removed from the active context. Search is on demand, so old material is not automatically injected into every turn. By default it uses session history; project-wide search can include sibling sessions.

`recall` uses BM25 search and, by default, a local embedding model for semantic matches. If embeddings are unavailable or disabled, lexical search still works. Its automatic compaction uses concise summaries as a working map; the original entries remain available to `recall`.

## Delegation and background work

`subagents` reads agent definitions from `~/.pi/agent/agents/`. Each Markdown file can provide YAML frontmatter such as:

```yaml
---
description: Review code for correctness and security
tools: [read, grep]
---
Review the requested change. Report actionable findings with file and line references.
```

Frontmatter can also set `model` and `thinking`. Available tools can be restricted with a list or per-tool map. One task runs with `subagent`; a batch runs in parallel with `subagents`. Each defined agent also gets a slash command named after it. Child runs are isolated and headless. The default is to wait for a result; `background: true` opts a task into the background.

Background shell and agent tasks can be inspected and managed with `task`, `task_kill`, `task_remind`, and `/tasks`. With wake messages enabled, a completed background task delivers its result automatically as the parent's next message; `task <id>` can peek at a running task, and `task_remind` sets an optional one-shot check-in. The extension's replacement `bash` keeps pi's normal behavior for `wait: "inline"` (the default). `wait: "auto"` waits up to its configured window before promoting a still-running command; `wait: "background"` starts it in the background immediately. Background work is session-scoped and is stopped when the session shuts down.

## OpenAI-compatible gateways

Create `~/.pi/agent/openai-gateways.json` to configure gateways. The top-level keys become provider names; each entry needs a `baseUrl` and may include `apiKey`, `contextWindow`, `maxTokens`, and a seed `models` list:

```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434/v1",
    "models": [{ "id": "qwen3" }]
  }
}
```

The extension discovers models from `<baseUrl>/models` and mirrors its catalog into pi's `~/.pi/agent/models.json`. This lets headless runs resolve the same models. Gateway config owns its provider name in that file (a same-named entry is replaced); other providers and settings are preserved.

## Configuration

Configuration is mostly through environment variables. Invalid values generally fall back to safe defaults; the extension source has the full list and parsing rules.

| Extension   | Common settings                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagents` | `PI_SUBAGENT_TIMEOUT_MS` (20-minute default), `PI_SUBAGENT_CONCURRENCY` (4), `PI_SUBAGENT_BG_AFTER_MS` (background adoption off by default), `PI_BASH_BG_AFTER_MS` (2-minute `auto` window), `PI_BG_WAKE=0` (suppress wake messages) |
| `recall`    | `PI_RECALL_SCOPE=session` (`project` includes sibling sessions), `PI_RECALL_EMBED=0` (disable embeddings), `PI_RECALL_COMPACT_TARGET=256000` (token cap; `0` disables), `PI_RECALL_COMPACT_RATIO=0.7` (fraction of the model window) |
| `goal`      | `PI_GOAL_MAX_CONTINUATIONS=25`, `PI_GOAL_MAX_TURNS_PER_RUN=50`, `PI_GOAL_VERIFY_TIMEOUT_MS=120000`; `PI_GOAL_CHECK_EVERY` throttles verification                                                                                     |
| `overflow`  | `PI_OVERFLOW_MAX_CHARS=10000`; `0` disables capping                                                                                                                                                                                  |

## Development

```sh
npm run check         # TypeScript check and full test suite
npm run check:format  # check formatting
npm test              # tests only
npm run format        # format source and tests
npm run bench:recall  # retrieval benchmark (uses a real session directory)
```

Tests exercise exported logic and use fakes for process, filesystem, and network boundaries; they do not launch pi or contact the network. The pi package dependency is pinned in `devDependencies` to provide the extension API types used during development.
