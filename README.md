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
| [`todo`](extensions/todo.ts)                       | `todo`, `/todos`                                                                   | Keeping a multi-step plan visible and recoverable across compaction, rewind, and resume. The agent replaces the complete list on each update; staleness reminders skip superbash wake-driven agent starts (a blocked plan is not a neglected one).                           |
| [`goal`](extensions/goal.ts)                       | `goal`, `/goal`                                                                    | Pursuing one high-level objective with per-criterion evidence required at completion. An optional verification command can drive an automatic work/check loop, bounded by continuation and turn limits; the turn-end check defers while background tasks run and is killable mid-run (alt+x).                                 |
| [`openai-gateways`](extensions/openai-gateways.ts) | OpenAI-compatible providers                                                        | Discovering models from local gateways and proxies such as Ollama, vLLM, or LM Studio, including for headless subagent runs.                                                                                                            |
| [`shortcuts`](extensions/shortcuts.ts)             | `/exit`, `/bye`, `/q`, `/close`, `/comp`, `/summarize`, `/info`, `/time`           | Common command aliases and quick session information.                                                                                                                                                                                   |
| [`review`](extensions/review.ts)                   | `/review`                                                                          | Local multi-stage code review: specialist finder agents review the diff in parallel, an adversarial verifier prunes false positives, and one severity-ranked report lands in the conversation.                                      |

## Plans, goals, and memory

These three extensions solve different problems:

- **`todo` is a plan.** Use it to track steps, status, and progress. Its state follows the active session branch, and `/todos` opens the full list.
- **`goal` is a commitment.** Use it for a larger objective. Add a `verify` command that reports the measured state and exits successfully only when the goal is met; the extension runs it, requires it to pass before completion, and continues the agent while it fails. Passing the check does not complete the goal automatically: the agent must still call `complete`. Completion also requires a summary and evidence text for every criterion, but that text is not independently validated (no semantic judge ships). Without `verify`, the goal is user-driven and does not auto-continue. The set-time baseline check and the completion check run inside the tool call: the tool row shows live progress while they run, and Esc aborts them (killing the verify's whole process tree — a heavyweight gate suite must never look wedged). The turn-end loop check shows its own spinner and is killable mid-run: pi exposes no abort signal at that boundary and a bare Esc is pi's own interrupt (plus popup-dismiss noise), so the extension watches raw terminal input for a dedicated kill chord — `alt+x`, bound by nothing in pi's defaults — and kills the check's whole tree; it is also bounded by `PI_GOAL_VERIFY_TIMEOUT_MS`, and `/goal stop` (or `/goal pause`) kills an in-flight check. The turn-end check also defers while superbash background tasks (backgrounded `bash` or subagents) are still running — the turn is only temporarily done then, since each completion wake re-engages the agent, so the check runs at the first settle with nothing in flight instead of measuring a half-finished state or blocking on a lock the running work holds; deferrals consume no continuation budget. `/goal <objective>` starts one, `/goal` shows status, `/goal pause` and `/goal resume` suspend and continue the pursuit, and `/goal stop` halts the loop. Goal and todo state (and the goal loop latch) persist as `<extension>.state` custom entries on the session branch via `pi.appendEntry` — the same pattern pi's built-in codemode store uses — written by tool actions and user commands alike, invisible to the model, and reconstructed on reload/rewind/resume by scanning the branch: a stopped or paused goal stays that way across a `/reload` instead of resurrecting. A model `set` while the loop is stopped is allowed (the cap's "adjust it" path) but the loop stays down — the tool result says so and the user gets a notice, the footer reads `goal · halted` instead of ticking a clock, and `/goal resume` re-arms an active-but-stopped loop, not just a paused goal.
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

## Code review

`/review` runs a multi-stage review pipeline over local changes — the same architecture as the hosted AI reviewers (parallel specialist finders, an adversarial verification pass, one merged report), but entirely local:

1. **Assemble** (deterministic): computes the diff, synthesizes diffs for untracked files, drops excluded paths (lockfiles, logs, generated and binary files), chunks on file boundaries, and collects repo instructions — `REVIEW.md` at the repo root plus the `## Review guidelines` section of the closest `AGENTS.md` for each changed file.
2. **Find**: one read-only subagent per lens — correctness, security, robustness, tests — explores the working tree with diff-anchored workflow instructions and returns findings as JSON. Large diffs chunk; a child cap bounds spend, shedding lenses (correctness first) and disclosing coverage when it binds. There is one configuration; the lens set is what every review gets.
3. **Verify** (opt-in, `PI_REVIEW_VERIFY=1`; off by default): one adversarial subagent re-traces every merged candidate against the diff and repo; only evidence-backed findings survive. A broken verifier fails open — findings are reported labeled unverified rather than dropped.
4. **Report**: deterministic dedupe (worst severity wins), severity ordering, and one markdown report delivered as a follow-up message. Findings persist to `<repo>/.pi/review-state.json`, so a re-review repeats still-valid findings verbatim and skips resolved ones.

Usage: `/review [target] [--model <m>] [--verify-model <m>]`. The target defaults to commits ahead of upstream plus uncommitted and untracked work; `staged`, `tree` (uncommitted only), a ref like `main`, or a range like `v1..v2` override. `--model`/`--verify-model` pin the child models per invocation (slashed names like `anthropic/claude-opus-4` work; env knob `PI_REVIEW_MODEL` persists the choice). The default finder model is `opencode-go/deepseek-v4.1-flash` — the benchmarked configuration — so reviews no longer inherit the session model unless `--model` says so. Reviewing with a different model than wrote the code reviews better. Repos can tailor reviews by adding a `REVIEW.md` or a `## Review guidelines` section to any `AGENTS.md` (the closest one to a changed file wins). Agents can run the same pipeline themselves via the `review` tool (compact findings back, full report under `.pi/review/` (exact path in the result)) — the global AGENTS.md points agents there to review their own work before committing. An optional read-only check command (`PI_REVIEW_CHECK_CMD`, e.g. `npm run check`) feeds its output to the verifier. Verification is off by default — the benchmark showed it costs ~half the wall time and buys no recall in diff-only mode; opt in with `PI_REVIEW_VERIFY=1` when you want an adversarial second pass (its findings are disclosed as verified, and a failed or skipped pass is disclosed, never silent).

`review` imports the subagent runtime, so keep both when packaging extensions selectively.

### Evaluating the reviewer

`npm run eval:review` scores the pipeline on [code-review-bench](https://huggingface.co/datasets/code-review-bench/code-review-bench) (CC-BY-4.0) — the expert-curated offline benchmark of 136 golden issues across 50 real PRs (cal.com, Discourse, Grafana, Keycloak, Sentry), extending Greptile's public 50-PR set. The dataset (cached under `scripts/eval/data/`, refresh instructions in its README) also has an online split with published precision/recall for 15 hosted reviewers — useful context for where a local pipeline lands.

The eval drives the production `runReview` over each cached diff (empty working tree, no git — a disclosed lower bound: finders normally confirm findings against the repo), matches findings to golden issues with an LLM judge (heuristic token-overlap fallback), and reports recall overall and by severity, findings-per-PR as a noise proxy, per-lens attribution, tokens, cost, and wall time. Children default to `opencode-go/deepseek-v4.1-flash` unless `PI_REVIEW_MODEL`/`PI_REVIEW_VERIFY_MODEL` are set; the recorded `model` in each result makes scores attributable. Knobs: `EVAL_PRS` (default 10; 50 = full benchmark), `EVAL_SEED`, `EVAL_JUDGE=0`, `EVAL_JUDGE_MODEL` (judge on a different model than the finders avoids same-model self-agreement bias), `EVAL_FROM=<fixture key>` to resume. It spawns real pi children, so it never runs under `npm test`; results append to `scripts/eval/results/` (gitignored).

Prompt or pipeline changes should re-run at least a fixed-seed sample before and after — the Copilot team's lesson applies here too: traces and benchmarks are how you debug reviewer behavior, not just scores.

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
| `goal`      | `PI_GOAL_MAX_CONTINUATIONS=25`, `PI_GOAL_MAX_TURNS_PER_RUN=50`, `PI_GOAL_VERIFY_TIMEOUT_MS=900000`; `PI_GOAL_CHECK_EVERY` throttles verification                                                                                     |
| `review`    | `PI_REVIEW_MODEL` (default `opencode-go/deepseek-v4.1-flash`), `PI_REVIEW_CHUNK_CHARS=96000`, `PI_REVIEW_MAX_CHILDREN=8`, `PI_REVIEW_TIMEOUT_MS`, `PI_REVIEW_MODEL`/`PI_REVIEW_VERIFY_MODEL` (child model overrides), `PI_REVIEW_CHECK_CMD` (read-only check whose output feeds verification), `PI_REVIEW_MAX_FINDINGS=25`, `PI_REVIEW_PRIOR_CHARS=8000`, `PI_REVIEW_STATE=0` (disable persistence), `PI_REVIEW_VERIFY=1` (opt into verification, off by default), `PI_REVIEW_UNTRACKED_MAX_BYTES`          |

## Development

```sh
npm run check         # TypeScript check and full test suite
npm run check:format  # check formatting
npm test              # tests only
npm run format        # format source and tests
npm run bench:recall  # retrieval benchmark (uses a real session directory)
```

Tests exercise exported logic and use fakes for process, filesystem, and network boundaries; they do not launch pi or contact the network. The pi package dependency is pinned in `devDependencies` to provide the extension API types used during development.
