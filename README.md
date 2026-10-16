# pi-extensions

A personal collection of [pi](https://pi.dev) coding-agent extensions. The common idea is to give an agent useful long-running capabilities while keeping its everyday context and tool surface small: work can be recovered, checked, or delegated without silently losing state.

## Install

Install the package once, then reload pi after editing the files:

```sh
pi install ~/Code/pi-extensions
pi list                       # verify the package is installed
```

Pi loads the TypeScript in this directory directly; there is no build step. The package registers the `extensions/` directory, so pi loads all included extensions. `recall` imports plan-rendering code from `todo`, so keep both if packaging extensions selectively.

## Extensions at a glance

| Extension                                        | Adds                                                                               | Useful for                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`subagents`](extensions/subagents/)             | `subagent`, `subagents`, background-task tools, `/tasks`, and named agent commands | Delegating work or running shell commands in parallel or background tasks. Blocking is default; wakes deliver results at turn boundaries. Replaces pi's `bash` tool with inline, auto, and background modes.                                        |
| [`recall`](extensions/recall/)                   | `recall`                                                                           | Finding details from earlier in the session after compaction. Searches archived turns with BM25 lexical ranking and optional local semantic search; also manages context compaction and summaries.                                                  |
| [`todo`](extensions/todo/)                       | `todo`, `/todos`                                                                   | Keeping a multi-step plan visible and recoverable across compaction, rewind, and resume. Replaces the complete list on each update; staleness reminders skip wake-driven agent starts.                                                              |
| [`goal`](extensions/goal/)                       | `goal`, `/goal`                                                                    | Pursuing one high-level objective with per-criterion evidence and an optional verification command. Bounded by continuation and pivot limits; a settle judge manages measurement cadence, progress, and typed stops. Killable mid-run with `alt+x`. |
| [`openai-gateways`](extensions/openai-gateways/) | OpenAI-compatible providers                                                        | Discovering models from local gateways and proxies such as Ollama, vLLM, or LM Studio, including for headless subagent runs.                                                                                                                        |
| [`shortcuts`](extensions/shortcuts/)             | `/exit`, `/bye`, `/q`, `/close`, `/comp`, `/summarize`, `/info`, `/time`           | Common command aliases and quick session information.                                                                                                                                                                                               |
| [`review`](extensions/review/)                   | `/review`                                                                          | Local multi-stage code review: specialist finder agents review the diff in parallel, an adversarial verifier prunes false positives, and one severity-ranked report lands in the conversation.                                                      |
| [`sshbash`](extensions/sshbash/)                 | `ssh_bash`                                                                         | Running commands on remote machines over multiplexed OpenSSH connections, sharing the same wait modes, wakes, and task tools as `bash`. Fast connection reuse (`ssh-1`), non-interactive auth, and remote group-SIGKILL. See [sshbash](#sshbash).   |
| [`superedit`](extensions/superedit/)             | replaces `edit`                                                                    | Forgiving-matcher edit tool: a three-tier ladder (exact bytes → Unicode/whitespace normalization → uniform indent shift), sequential chained edits, occurrence disambiguation, and line-numbered diff diagnostics. See [superedit](#superedit).     |
| [`pushover`](extensions/pushover/)               | nothing (event listener)                                                           | Phone notifications when a goal completes, via [Pushover](https://pushover.net). Subscribes to typed completion events with zero model surface; fails open. See [pushover](#pushover).                                                              |

## Design docs

Deeper design work lives in [`docs/`](docs/). Start with [`docs/goal-loop-design.md`](docs/goal-loop-design.md) — the goal loop's control architecture (single spending question, gated stops, pivots, and feasibility projections), written from the post-mortem of a 26-hour autonomous campaign and now fully implemented.

## superedit

The `edit` tool this package registers replaces pi's built-in tool by name (the same cut as superbash's `bash`), for one reason: agents kept working around the built-in with `python3 - <<EOF` + `str.replace` scripts whenever an `oldText` didn't match byte-for-byte or matched twice. superedit keeps every correctness guarantee and removes the dead ends:

- **A three-tier matching ladder, strictest first.** Exact bytes; then pi's own Unicode/whitespace normalization (NFKC, trailing whitespace, smart quotes/dashes); then a whole-line match with a _uniform_ indentation shift — the heredoc repair. The uniformity requirement is what makes the elastic tier safe: a block whose indentation is consistently off by one shift matches and the replacement is re-indented by that same shift, while a block with internally inconsistent indentation refuses and the error names the exact lines that break the shift. The ladder decides _when_ text matches, never _which_ match wins silently.
- **Sequential edits.** `edits[]` apply in order, each `oldText` matched against the file as it stands after earlier edits — so chained edits work, and an edit that targets text an earlier edit rewrote gets an error naming both edits and suggesting the merge. Everything is matched in memory before anything is written: one call is all-or-nothing.
- **Duplicates are a choice, not a guess.** A non-unique `oldText` is still an error — but the error lists up to five locations with line numbers (then "...and N more"), and `edits[].occurrence` (1-based index in file order, or `"all"`, capped at 20 sites) lets the next call disambiguate without repasting context.
- **Failures carry diagnostics.** Not-found runs an anchor search (with a length-skew-tolerant similarity seed for typo'd or drifted text — pointing at the right line even for a sentence carved out of a long one) and shows the closest region as a capped, line-numbered `-/+/context` diff plus whitespace forensics (tabs vs spaces, leading columns). If nothing looks similar it says so with the file's line count, and a search cut short by budget says that instead of naming a false cause. Every message is bounded so a failure never floods context.
- **Every forgiveness is reported.** The success message names each non-exact application (`matched with indentation flexibility (shift +4)`, `replaced 3 occurrences`) and the result carries the usual diff, making elastic applications fully auditable in the transcript.

BOM and line endings round-trip exactly like the built-in. The whole search runs under one comparison budget, so neither a huge nor a massively repetitive file can wedge it: an exhausted budget refuses with a cut-short message rather than a false diagnosis. `PI_SUPEREDIT=0` falls back to pi's built-in edit; `PI_SUPEREDIT_ALL_CAP` adjusts the `occurrence: "all"` cap (default 20, max 1000).

## pushover

Phone notifications when a goal completes. Two deliberate cuts:

- **Events, not sniffing.** The `goal` extension emits a typed `GoalCompletedEvent` from `lib/goal-events.ts` at the moment its completion gates pass — after the state change is durable. Consumers subscribe to that contract instead of reverse-engineering another extension's tool I/O shapes. pi's event bus has no custom channels for extensions, so the bus is a listener map hung off a `Symbol.for` process-global — the same cut as superbash's shared task registry, ensuring separate extension module instances connect reliably. Registration is owner-keyed, so a `/reload` replaces its listener instead of stacking duplicates.
- **Events are gossip.** Producers never await or block; a listener that throws is logged and dropped; zero listeners is the normal case. On the transport side: unconfigured means inert (registers nothing), and a failed or rejected POST is logged and dropped — a notification channel must never break the work it observes.

Configuration: set both `PI_PUSHOVER_TOKEN` and `PI_PUSHOVER_USER` (from your Pushover app and user keys). The notification title leads with the project name (`pi-extensions · Goal #3 complete: …`) for lock screens; the body carries the summary, criteria count, and working directory. Title and message respect Pushover's 250/1024 limits and each POST is bounded to 10 seconds.

## sshbash

`ssh_bash` brings the unified `bash` tool interface to remote machines over OpenSSH:

- **OpenSSH connection multiplexing.** Uses `ControlMaster`, `ControlPath`, and `ControlPersist` (`<agentDir>/ssh/`). The first call to a destination pays the SSH handshake; subsequent calls connect in milliseconds with no re-authentication. Masters idle out after `PI_SSH_IDLE_SECS` (default 600s) and close on session shutdown.
- **Non-interactive auth.** Runs with `BatchMode=yes` (key/agent/config only). If authentication cannot proceed non-interactively, it fails fast with SSH stderr instead of hanging waiting for user input.
- **Session-scoped connection handles.** Each distinct destination (`user@host:port`) receives a handle (`ssh-1`, `ssh-2`, …). Subsequent calls can pass this handle as `target` instead of repeating the destination address.
- **Remote process-group cancellation.** Commands run as `sh -s` scripts fed on stdin (never exposed in argv). A per-call nonce marker makes each execution's remote process group addressable, allowing `task_kill` and timeouts to group-SIGKILL the remote process tree cleanly.
- **Full superbash parity.** Supports the same wait modes (`inline`, `auto`, `background`), wake notifications, logging, and task inspection tools as local `bash`.

## Plans, goals, and memory

These three extensions solve different problems across the agent lifecycle:

### `todo`: Session Plan

Use `todo` to track concrete steps, status, and progress.

- Its state follows the active session branch and survives context compaction, rewind, and resume.
- Use `/todos` to view the plan full-screen in the TUI.
- Staleness reminders re-surface the plan when turns pass without updates, but automatically ignore machine wake-driven agent starts (background task completions or check-ins).

### `goal`: Objective Commitment and Autonomous Loop

Use `goal` for larger objectives requiring verified completion.

- **Verification and Completion Gates:** A goal can define a `verify` command that measures state and exits 0 only when the objective is met. Passing `verify` does not complete the goal automatically: the agent must still invoke `goal(action: "complete")` with a summary and specific evidence for every criterion.
- **The Settle Judge:** At each turn end, a settle judge (a tool-less model call inheriting the session model unless pinned by `PI_GOAL_JUDGE_MODEL`) evaluates progress. For verify goals, the judge directs measurement cadence: mid-work turns continue without paying for expensive verification scripts, while completion claims or stale measurements trigger `measure: true`. A trajectory tail and computed feasibility projection (observed rate vs. remaining gap vs. budget) are handed to the judge to cite. The judge fails open to plain continuation if unavailable.
- **Pivots and Typed Stops:** Stuck goals or impasse claims are scrutinized. If progress stalls or `blocked` is requested, the system offers a procedural reframe if a pivot remains (`PI_GOAL_MAX_PIVOTS`, default 1), granting a fresh continuation budget window. When budgets or caps are exhausted, the loop latch parks with a typed decision packet (`impasse`, `premise`, `budget`, or `work-appears-complete`) and emits a `GoalParked` event.
- **Background Task Coordination:** The settle judge receives running background tasks and can answer `hold` (deferring checks until tasks finish without consuming continuation budget), while avoiding deadlocks on long-running processes like development servers.
- **Interruption and Persistence:** Turn-end loop checks can be killed mid-run via `alt+x` (a dedicated terminal chord that avoids interrupting pi itself). Goal state and loop latches persist as `goal.state` entries on the session branch, preserving exact status across `/reload`, rewind, and resume.
- **Commands:** `/goal <objective>` starts a goal, `/goal` displays current status, `/goal pause` and `/goal resume` suspend or re-authorize pursuit, and `/goal stop` halts the loop.

### `recall`: Searchable History

Use `recall` to find decisions, code snippets, or rationale that compaction removed from active context.

- Runs on-demand; earlier turns are not blindly injected into every turn.
- Combines BM25 lexical ranking with optional local semantic embeddings.
- Manages automatic context compaction using concise summaries while keeping raw entries searchable.
- `PI_RECALL_SCOPE=session` searches the current session; `project` includes sibling sessions.

## Delegation and background work

### Defining Subagents

`subagents` reads agent definitions from `~/.pi/agent/agents/*.md`. Frontmatter configures tools, models, and thinking:

```yaml
---
description: Review code for correctness and security
tools: [read, grep]
thinking: medium
---
Review the requested change. Report actionable findings with file and line references.
```

Each defined agent automatically registers a matching `/name` slash command. Child runs are isolated and headless.

### Execution and Thinking Levels

- `subagent` runs a single delegated task; `subagents` runs a batch of tasks in parallel with bounded concurrency (`PI_SUBAGENT_CONCURRENCY`, default 4).
- Thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) can be specified per call, overriding the agent definition or the default (`low`).
- Child runs use the agent definition's `model` or inherit the parent session's model.

### Idle Watchdog

Every child run is protected by an idle watchdog (`PI_SUBAGENT_IDLE_TIMEOUT_MS`, default 5m; `0` disables). It tracks LLM stream events: if a model request goes silent for longer than the window (e.g. hung connection or wedged stream), the child is terminated immediately. Tool executions (such as long compilation or test runs) suspend the watchdog.

### Background Tasks and `bash`

- Tasks can run in the background with `background: true`.
- Background tasks return a task ID immediately and deliver their result as a steering wake at the parent agent's next turn boundary.
- Tasks are inspected and managed with `task <id>`, `task_kill <id>`, `task_remind`, and `/tasks`.
- The included `bash` tool replaces pi's default with support for wait modes:
  - `wait: "inline"` (default): blocks until completion.
  - `wait: "auto"`: waits up to `PI_BASH_BG_AFTER_MS` (default 2m) before promoting to the background.
  - `wait: "background"`: immediately backgrounds the command.

## Code review

`/review` runs an expert multi-stage review pipeline over local changes:

1. **Assemble** (deterministic): Computes diffs (including untracked files), filters out lockfiles/binaries, chunks across file boundaries, and collects repository guidelines from `REVIEW.md` and `## Review guidelines` in `AGENTS.md`.
2. **Find**: Spawns parallel read-only subagents across four specialist lenses (correctness, security, robustness, tests). Changed files are attached directly to tasks (`PI_REVIEW_ATTACH_CHARS=64000`) so finders do not spend extra round trips re-reading files.
3. **Verify** (default on; `PI_REVIEW_VERIFY=0` opts out): An adversarial subagent re-traces candidates against the repo, rejecting findings that lack evidence or fail mechanism checks.
4. **Report**: Deduplicates findings, orders by severity, and posts a markdown report. Results persist to `<repo>/.pi/review-state.json` so repeat reviews skip resolved findings.

### Usage and Options

- Command: `/review [target] [--model <m>] [--verify-model <m>]`
- Target defaults to unpushed commits and uncommitted/untracked changes; can target `staged`, `tree`, a branch name, or a revision range.
- Default finder model is `opencode-go/deepseek-v4.1-flash:off`.
- Tool integration: Agents can execute the pipeline themselves via the `review` tool before committing changes.
- Pre-commit check integration: `PI_REVIEW_CHECK_CMD` (e.g. `npm run check`) runs a check command and feeds its output into the verification stage.

### Evaluating the Reviewer

Run `npm run eval:review` to evaluate review performance against [code-review-bench](https://huggingface.co/datasets/code-review-bench/code-review-bench) (136 curated issues across 50 real PRs). Controls include `EVAL_PRS`, `EVAL_SEED`, `EVAL_JUDGE_MODEL`, `EVAL_REJUDGE`, and `EVAL_VERIFY_REPLAY`.

## OpenAI-compatible gateways

Configure local proxies and gateways (such as Ollama, vLLM, or LM Studio) in `~/.pi/agent/openai-gateways.json`:

```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434/v1",
    "models": [{ "id": "qwen3" }]
  }
}
```

The extension queries `<baseUrl>/models` and mirrors discovered models into pi's `~/.pi/agent/models.json`, ensuring headless and subagent runs can resolve them.

## Configuration

Configuration is managed via environment variables. Invalid values fall back to safe documented defaults:

| Extension   | Settings and Knobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents` | `PI_SUBAGENT_TIMEOUT_MS` (default 20m), `PI_SUBAGENT_BIN` (child binary override; defaults to parent binary), `PI_SUBAGENT_IDLE_TIMEOUT_MS=300000` (5m LLM watchdog; `0` disables), `PI_SUBAGENT_CONCURRENCY=4`, `PI_SUBAGENT_BG_AFTER_MS` (auto-backgrounding threshold; disabled by default), `PI_BASH_BG_AFTER_MS=120000` (2m `auto` window), `PI_BG_WAKE=0` (suppress wake messages)                                                                                                                 |
| `recall`    | `PI_RECALL_SCOPE=session` (`project` includes sibling sessions), `PI_RECALL_EMBED=0` (disable embeddings), `PI_RECALL_WORKER_BIN` (embed worker interpreter: node ≥ 22.18 or bun), `PI_RECALL_COMPACT_TARGET=80000` (token cap for every model — issue #3's measured cost optimum; `0` disables), `PI_RECALL_COMPACT_RATIO=0.7`, `PI_RECALL_COMPACT_IDLE_RATIO=0.875` (idle early-fire at this fraction of the target — 70k at the 80k target), `PI_RECALL_SUMMARY_CACHE=0` (disable KV prompt cache reuse), `PI_RECALL_COMPACT_OWN=0` (use pi's default summaries), `PI_RECALL_SUMMARY_CHARS=5000`, `PI_RECALL_SUMMARY_THINKING=off` (one-off layout only — cached-layout summaries mirror the session's level so the replayed prefix renders identically), `PI_RECALL_DEBUG_PREFIX=1` (dump the cached-layout summary payload paired with the last live payload as `<sessionDir>/recall-debug/<sessionId>-diff.json` for first-divergence diffing; the dump is the full unredacted transcript — treat it as secret-bearing and delete after diagnosis) |
| `goal`      | `PI_GOAL_MAX_CONTINUATIONS=25`, `PI_GOAL_MAX_PIVOTS=1` (procedural reframes; `0` disables), `PI_GOAL_MAX_TURNS_PER_RUN=50`, `PI_GOAL_VERIFY_TIMEOUT_MS=900000` (15m), `PI_GOAL_CHECK_EVERY` (throttle verify runs to every Nth continuation), `PI_GOAL_JUDGE=0` (disable settle judge), `PI_GOAL_JUDGE_MODEL` (pin judge model), `PI_GOAL_JUDGE_TIMEOUT_MS=180000` (3m)                                                                                                                                  |
| `sshbash`   | `PI_SSH_IDLE_SECS=600` (OpenSSH control master idle timeout), `PI_SSH_CONNECT_TIMEOUT=15` (connection establishment timeout), `PI_SSH_STRICT_HOST_KEY=accept-new` (TOFU policy; accepts `yes`, `no`, `ask`, `off`, `accept-new`). Also honors `PI_BASH_BG_AFTER_MS` and `PI_BG_WAKE`.                                                                                                                                                                                                                    |
| `review`    | `PI_REVIEW_MODEL` (default `opencode-go/deepseek-v4.1-flash:off`), `PI_REVIEW_VERIFY_MODEL`, `PI_REVIEW_CHUNK_CHARS=96000`, `PI_REVIEW_ATTACH_CHARS=64000`, `PI_REVIEW_MAX_CHILDREN=8`, `PI_REVIEW_CONCURRENCY=8`, `PI_REVIEW_TIMEOUT_MS`, `PI_REVIEW_IDLE_TIMEOUT_MS=300000`, `PI_REVIEW_CHECK_CMD` (read-only verification check command), `PI_REVIEW_MAX_FINDINGS=25`, `PI_REVIEW_PRIOR_CHARS=8000`, `PI_REVIEW_STATE=0` (disable persistence), `PI_REVIEW_VERIFY=0` (disable verification pass)      |
| `superedit` | `PI_SUPEREDIT=0` (fall back to pi's built-in `edit`), `PI_SUPEREDIT_ALL_CAP=20` (max replacements for `occurrence: "all"`; clamped to 1000)                                                                                                                                                                                                                                                                                                                                                              |
| `pushover`  | `PI_PUSHOVER_TOKEN` and `PI_PUSHOVER_USER` (both required; unconfigured extension remains completely inert)                                                                                                                                                                                                                                                                                                                                                                                              |

## Development

### pi and pi-bolt

The package runs unchanged under stock pi and under [pi-bolt](https://github.com/opensec-git/Pi-Bolt) (the AOT-compiled pi fork). Both share `~/.pi/agent`, so sessions, settings, and installed extensions are shared:

- `recall`'s embed worker runs under a standard JS interpreter (stock pi's Node/Bun, system `node`, or `bun`). If unresolved, it fails open to lexical search (`PI_RECALL_WORKER_BIN` pins an interpreter).
- `subagents` and `goal` child runs spawn using the same agent binary as their parent (`PI_SUBAGENT_BIN` overrides).

Runtime-loaded extensions are interpreted (not JIT-compiled) under pi-bolt's default build. Extensions are primarily I/O- and child-process-bound, incurring no measurable overhead. The transpile cache in `~/.pi/agent/cache/jiti` is shared.

### Commands

```sh
npm run check         # TypeScript check and full test suite (must pass before every commit)
npm test              # vitest suite only
npx tsc --noEmit      # typecheck only
npm run check:format  # verify formatting
npm run format        # format source, scripts, and tests
npm run bench:recall  # retrieval benchmark against a real session directory
```

Tests exercise exported logic and use fakes for process, filesystem, and network boundaries; they do not launch pi or contact the network.
