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

| Extension                                        | Adds                                                                               | Useful for                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`subagents`](extensions/subagents/)             | `subagent`, `subagents`, background-task tools, `/tasks`, and named agent commands | Delegating work or running shell commands in parallel or background tasks. Blocking is default for subagents; wakes deliver results at turn boundaries. Replaces pi's `bash` tool: quick commands return inline, and anything still running after a ~5m window moves to the background automatically. Children run isolated but can load extensions opt-in (`extensions:` frontmatter, `PI_SUBAGENT_EXTENSIONS`). |
| [`recall`](extensions/recall/)                   | `recall`                                                                           | Finding details from earlier in the session after compaction. Searches archived turns with BM25 lexical ranking and optional local semantic search; also manages context compaction and summaries.                                                                                                                                                                                                                |
| [`todo`](extensions/todo/)                       | `todo`, `/todos`                                                                   | Keeping a multi-step plan visible and recoverable across compaction, rewind, and resume. Replaces the complete list on each update; staleness reminders skip wake-driven agent starts.                                                                                                                                                                                                                            |
| [`goal`](extensions/goal/)                       | `goal`, `/goal`                                                                    | Pursuing one high-level objective with per-criterion evidence and an optional verification command. Bounded by continuation and pivot limits; a settle judge manages measurement cadence, progress, and typed stops. Killable mid-run with `alt+x`.                                                                                                                                                               |
| [`openai-gateways`](extensions/openai-gateways/) | OpenAI-compatible providers                                                        | Discovering models from local gateways and proxies such as Ollama, vLLM, or LM Studio, including for headless subagent runs.                                                                                                                                                                                                                                                                                      |
| [`shortcuts`](extensions/shortcuts/)             | `/exit`, `/bye`, `/q`, `/close`, `/comp`, `/summarize`, `/info`, `/time`           | Common command aliases and quick session information.                                                                                                                                                                                                                                                                                                                                                             |
| [`review`](extensions/review/)                   | `/review`                                                                          | Local multi-stage code review: specialist finder agents review the diff in parallel, an adversarial verifier prunes false positives, and one severity-ranked report lands in the conversation.                                                                                                                                                                                                                    |
| [`sshbash`](extensions/sshbash/)                 | `ssh_bash`                                                                         | Running commands on remote machines over multiplexed OpenSSH connections, sharing the same wait modes, wakes, and task tools as `bash`. Fast connection reuse (`ssh-1`), non-interactive auth, and remote group-SIGKILL. See [sshbash](#sshbash).                                                                                                                                                                 |
| [`superedit`](extensions/superedit/)             | replaces `edit`                                                                    | Forgiving-matcher edit tool: a three-tier ladder (exact bytes → Unicode/whitespace normalization → uniform indent shift), sequential chained edits, occurrence disambiguation, and line-numbered diff diagnostics. See [superedit](#superedit).                                                                                                                                                                   |
| [`pushover`](extensions/pushover/)               | nothing (event listener)                                                           | Phone notifications when a goal completes, via [Pushover](https://pushover.net). Subscribes to typed completion events with zero model surface; fails open. See [pushover](#pushover).                                                                                                                                                                                                                            |
| [`activity`](extensions/activity/) | nothing (status adapter) | Keeps OSC 7501 terminal status working while extensions hold background activity; shared opt-in API in `lib/activity.ts`. |
| [`antigravity`](extensions/antigravity/)         | `antigravity` provider                                                             | A slim in-repo fork of pi-antigravity: Gemini/Claude/GPT-OSS via Google Cloud Code Assist with our own auth and live model catalog — models, nothing else. See [antigravity](#antigravity).                                                                                                                                                                                                                       |

## Extension activity and terminal status

The `activity` extension keeps Pi's terminal status **working** while extensions have unfinished background work, even after the agent run settles. This fixes premature completion in the **Herdr app / herdr-core (`hc`)** and other terminals supporting Pi's native OSC 7501 program-status protocol. It requires no Herdr installation hook or socket configuration. The separate Herdr terminal multiplexer and its `pane.report_agent` integration are not targeted by this adapter.

### Opt in from any extension

```ts
import { bindActivity } from "../../lib/activity";

export default function (pi) {
  const activity = bindActivity(pi, "my-extension");
  // Inside a tool, command, or session event, after session_start:
  async function doWork() {
    const release = activity.hold();
    try {
      await backgroundWork();
    } finally {
      release();
    }
  }
}
```

- Holds are counted across extensions in the same session. Release functions are idempotent. Each binding releases its own holds and detaches its observers on shutdown; late callbacks cannot release a replacement session's work. Calls before startup or after shutdown are inert.
- `activity.count` and `activity.subscribe(count => ...)` expose the aggregate to other consumers. Subscriptions replay current state once connected; the returned function unsubscribes. Observer errors fail open. No model messages, tokens, or extra tools are involved.
- Local `bash`, `ssh_bash`, and background subagents consume this API through their shared task registry. Completion, failure, kill, revive, persistent-task detach, and resume adoption all update holds. Reminders reuse the running job's hold. Persistent jobs reacquire holds when re-adopted, not while Pi is absent.
- A running server or watcher counts as unfinished work too, even with `PI_BG_WAKE=0`. There is no attempt to infer whether a job is relevant from command text. For custom extensions, acquire a hold only for work whose completion the session is waiting for—not perpetual maintenance timers.

### Reporting and limitations

Pi does not yet expose a busy-hold/status middleware API. A small compatibility adapter decorates the public TUI terminal's `setProgramStatus` method, reached through a zero-row widget factory. It changes only native **idle/done → working** while holds exist, before the report reaches the terminal; emitting a correction afterward would already let `hc wait` return. Native **working, blocked, error, and clear** retain their meaning, and the latest unmodified native state is restored after the last hold releases. Pi still controls encoding, capability negotiation, compaction, dialogs, and `PI_PROGRAM_STATUS`. The adapter is TUI-only: headless children cannot report against their parent's terminal.

A fixed **100 ms last-release grace** bridges ordinary wake scheduling. Pi's `sendUserMessage` API returns no acceptance acknowledgment: rejected/consumed wakes must not leave the session busy forever, and input hooks taking longer than the grace can still create a completion gap. Attention states (blocked/error) and clear are never delayed. This is a reporting compatibility shim, **not** a change to `ctx.isIdle()`, Pi scheduling, or shutdown rules. It does not hide errors or user questions merely because jobs remain running.

On reload, the adapter retains the last native report it observed and removes its wrapper/subscriptions/timers on teardown. If first installed by reload into an already idle session, the setter-only API cannot recover an earlier error/dialog report; until Pi reports again, the initial baseline comes from `ctx.isIdle()`. Set `PI_ACTIVITY_STATUS=0` to disable the terminal adapter without disabling the generic API. Terminals that do not confirm OSC 7501 support receive no reports, just as with stock Pi. The shim is tested against Pi **1.5.2** and should be revisited when Pi gains a native activity API.

## Design docs

Deeper design work lives in [`docs/`](docs/). Start with [`docs/goal-loop-design.md`](docs/goal-loop-design.md) — the goal loop's control architecture (single spending question, gated stops, pivots, and feasibility projections), written from the post-mortem of a 26-hour autonomous campaign and now fully implemented.

## superedit

The `edit` tool this package registers replaces pi's built-in tool by name (the same cut as superbash's `bash`), for one reason: agents kept working around the built-in with `python3 - <<EOF` + `str.replace` scripts whenever an `oldText` didn't match byte-for-byte or matched twice. superedit keeps every correctness guarantee and removes the dead ends:

- **A three-tier matching ladder, strictest first.** Exact bytes; then pi's own Unicode/whitespace normalization (NFKC, trailing whitespace, smart quotes/dashes); then a whole-line match with a _uniform_ indentation shift — the heredoc repair. The uniformity requirement is what makes the elastic tier safe: a block whose indentation is consistently off by one shift matches and the replacement is re-indented by that same shift, while a block with internally inconsistent indentation refuses and the error names the exact lines that break the shift. The ladder decides _when_ text matches, never _which_ match wins silently.
- **Sequential edits.** `edits[]` apply in order, each `oldText` matched against the file as it stands after earlier edits — so chained edits work, and an edit that targets text an earlier edit rewrote gets an error naming both edits and suggesting the merge. Everything is matched in memory before anything is written: one call is all-or-nothing.
- **Duplicates are a choice, not a guess.** A non-unique `oldText` is still an error — but the error lists up to five locations with line numbers (then "...and N more"), and `edits[].occurrence` (1-based index in file order, or `"all"`, capped at 20 sites) lets the next call disambiguate without repasting context.
- **Failures carry diagnostics.** Not-found runs an anchor search (with a length-skew-tolerant similarity seed for typo'd or drifted text — pointing at the right line even for a sentence carved out of a long one) and shows the closest region as a capped, line-numbered `-/+/context` diff plus whitespace forensics (tabs vs spaces, leading columns). When the similarity seed finds the region but no line matches exactly (e.g. the block was rewritten or reformatted), the oldText side is dropped for a plain listing of the file's bytes — the caller already holds its own oldText, and pairing non-corresponding lines misleads more than it informs. If nothing looks similar it says so with the file's line count, and a search cut short by budget says that instead of naming a false cause. Every message is bounded so a failure never floods context, and states facts only — what matched, where, and why it failed — never instructions; deciding what to do is the caller's job.
- **Every forgiveness is reported.** The success message names each non-exact application (`matched with indentation flexibility (shift +4)`, `replaced 3 occurrences`) and the result carries the usual diff, making elastic applications fully auditable in the transcript.
- **Advisory syntax check after the write.** For tree-sitter-supported file types (TypeScript/TSX, JavaScript/JSX, Python, JSON, Go, Rust, YAML, HTML, CSS) the landed content is parsed and the result carries a capped warning naming `ERROR`/`MISSING` nodes on the lines the call actually rewrote — never a refusal, never a blame shift for pre-existing breakage (a differential re-parse of the pre-edit content suppresses old damage; when the two parses together exceed the 512 KB budget — roughly 256 KB files — the differential is skipped and the warning is undifferentiated, because surfacing a mangled edit outranks attribution at that size). Every hiccup (unknown type, missing grammar, oversize file) fails open to silence. `PI_SUPEREDIT_SYNTAX=0` disables it per session.

BOM and line endings round-trip exactly like the built-in. The whole search runs under one comparison budget, so neither a huge nor a massively repetitive file can wedge it: an exhausted budget refuses with a cut-short message rather than a false diagnosis. `PI_SUPEREDIT=0` falls back to pi's built-in edit; `PI_SUPEREDIT_ALL_CAP` adjusts the `occurrence: "all"` cap (default 20, max 1000).

## antigravity

A slim fork of Rahul Arya's [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) v0.12.0 (MIT — see `extensions/antigravity/LICENSE-pi-antigravity`), vendored in-repo so the wire-protocol code is ours to patch when Google's Cloud Code Assist endpoints move or pi's provider API changes. The surface is exactly the model bit — the provider, auth, and the live catalog:

- **The `antigravity` provider** — same provider id and OAuth credential shape as upstream, so the Google credentials already in `~/.pi/agent/auth.json` (`/login antigravity`) keep working with no re-login; pi refreshes tokens through this fork's handlers. Keep upstream's OAuth client id (it does — refresh tokens are bound to the client that minted them).
- **Streaming + dynamic model catalog** — the `streamSimple` implementation over `v1internal:streamGenerateContent`, thinking-level routing, and `fetchAvailableModels` discovery that groups runtime variants into public ids (new Gemini generations become selectable without an extension release). A last-known-good catalog is persisted through pi's model store and refreshed at session start and every 4h (`ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS`, `0` = every session).

Cut vs upstream (all deliberate; see the `index.ts` header): the `google_search` and `generate_image` tools (modules deleted, not disabled), multi-account store + automatic 429 account failover, `/antigravity.*` slash commands, the native image-API registration, and the `undici` dependency (plain `fetch` — its keep-alive pool was already a no-op on Node ≥ 22). A hard quota wall surfaces as an ordinary error pi can retry. On top of upstream, the stream implements pi's provider contract fully: request/response instrumentation hooks (`onPayload`, `onResponse`, `onProviderStreamEvent`), context-overflow errors normalized so pi can compact-and-retry, and terminal error wording kept on pi's retry classifier (transient 408/429/5xx/timeouts auto-retry; auth, quota walls, and dead models fail fast; a `MALFORMED_FUNCTION_CALL` finish reason — a transient Gemini tool-call flake — is worded retryable so pi auto-retries the turn instead of dead-ending it) — locked by tests that run our messages through pi's real `isRetryableAssistantError`.

Switching from the npm package: `pi remove npm:pi-antigravity`, then `/reload`. The two register the same provider id, so they must not be installed together. Files stay close to upstream layout so upstream fixes can be diffed and cherry-picked.

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
- **Full superbash parity.** Supports the same wait modes (`auto` default, `inline`, `background`), wake notifications, logging, and task inspection tools as local `bash`. A remote command still running after the auto window is moved to the background like a local one. The TUI row matches too — pi's shell renderers (live `Elapsed` timer, capped output preview) are resolved for `ssh_bash` the way pi grafts them onto the builtin-named `bash`.

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

`subagents` reads agent definitions from `~/.pi/agent/agents/*.md`. Frontmatter configures tools, models, thinking, and extensions:

```yaml
---
description: Review code for correctness and security
tools: [read, grep]
thinking: medium
---
Review the requested change. Report actionable findings with file and line references.
```

Each defined agent automatically registers a matching `/name` slash command. Child runs are isolated and headless: no extensions, skills, prompt templates, context files, or MCP servers by default.

### Loading Extensions into Children

By default a child sees only pi's built-in tools — loading the parent's extensions wholesale would bloat every child's tool surface, risk recursion (subagents spawning subagents), and make runs depend on whatever happens to be installed. But some capabilities only exist as extensions (`ssh_bash`, gateway providers, …), so an agent can opt in per name:

```yaml
---
description: Investigate on remote machines
extensions: [sshbash, openai-gateways]
tools: [read, grep, ssh_bash]
model: yeti/qwen3.8-27b
---
Investigate the remote host…
```

- Names are sibling directories of this package's `extensions/`; the child loads each via an explicit `-e <path>` flag — extension _discovery_ stays off (`--no-extensions` and `--no-mcp` are always passed), so an opted-in child gets exactly the named extensions and nothing else.
- Extension tools are granted by naming them in the `tools:` allowlist (as `ssh_bash` above). The child's tool set is always an explicit allowlist — never inherited from pi settings — and the `tools:` map form can only restrict builtins, not grant extension tools.
- Only agent files under `~/.pi/agent/agents` may declare `extensions:` — inline `agent_md` is model-authored, and a definition granting itself extension capabilities would be escalation by prompt, so it is stripped there (with a warning).
- `PI_SUBAGENT_EXTENSIONS=sshbash,openai-gateways` applies the same list to every agent that doesn't declare its own — including ad-hoc ones — one knob to give all subagents gateway providers, say. Extension tools named in an agent's `tools:` survive when the knob fills the gap.
- The knob also takes third-party extensions two ways: `npm:<package>` shorthands — the same spelling `pi list` shows, resolved under `~/.pi/agent/npm/node_modules` via the package's `main` or its conventional entry — and absolute or `~`-relative paths to an entry file or directory. Both `npm:` shorthands and sibling names are validated shapes allowed in agent-file frontmatter too; raw paths are env-only (human-authored config) so a model-authored definition can never point a child at arbitrary code.
- The natural fix for "subagent exited with `Model "..." not found"": the model's provider is registered by an extension the child can't see (e.g. a gateway); when the child ran extensionless the run's error says exactly this, and `extensions:` (or the env knob) is the fix. The openai-gateways models.json mirror already covers gateway models for children that don't opt in.

### Execution and Thinking Levels

- `subagent` runs a single delegated task; `subagents` runs a batch of tasks in parallel with bounded concurrency (`PI_SUBAGENT_CONCURRENCY`, default 4).
- Thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) can be specified per call, overriding the agent definition or the default (`low`).
- Child runs use the agent definition's `model` or inherit the parent session's model. A model the child cannot resolve doesn't fail the run: the failure is instant and token-free (pi exits before any inference), so the child retries once on a fallback — a pinned model falls back to the session's, a session-inherited one to pi's default — and the result is prefixed with `[model fallback: …]` naming the model that actually ran. Failures past resolution (provider down mid-run, auth, quota) still surface as errors.
- `/review`'s `--model` / `--verify-model` and agent-file pins get the same fallback.

### Idle Watchdog

Every child run is protected by an idle watchdog (`PI_SUBAGENT_IDLE_TIMEOUT_MS`, default 5m; `0` disables). It tracks LLM stream events: if a model request goes silent for longer than the window (e.g. hung connection or wedged stream), the child is terminated immediately. Tool executions (such as long compilation or test runs) suspend the watchdog.

### Background Tasks and `bash`

- Tasks can run in the background with `background: true`.
- Background tasks return a task ID immediately and deliver their result as a steering wake at the parent agent's next turn boundary.
- Tasks are inspected and managed with `task <id>`, `task_kill <id>`, `task_remind`, and `/tasks`.
- The included `bash` tool replaces pi's default with support for wait modes:
  - `wait: "auto"` (default): blocks for up to `PI_BASH_BG_AFTER_MS` (default 5m) — a command that finishes in time returns its output inline, one that exceeds the window is moved to the background automatically (task id returned, result delivered as a wake). Long foreground commands no longer park the session.
  - `wait: "inline"`: the deliberate unbounded block — delegates to pi's own bash tool and waits in-turn however long the command runs.
  - `wait: "background"`: immediately backgrounds the command.
  - `persist: true` (with `wait: "background"`): the command survives pi exiting and restarting — it runs detached with its state on disk, shutdown spares it, and the next session reports its outcome (or re-adopts it) as a wake. `PI_BG_BASH_PERSIST=1` makes this the default for background commands; `persist: false` overrides. Not available in `ssh_bash`.

## Code review

`/review` runs an expert multi-stage review pipeline over local changes:

1. **Assemble** (deterministic): Computes diffs (including untracked files), filters out lockfiles/binaries, chunks across file boundaries, and collects repository guidelines from `REVIEW.md` and `## Review guidelines` in `AGENTS.md`.
2. **Find**: Spawns parallel read-only subagents across four specialist lenses (correctness, security, robustness, tests). Changed files are attached directly to tasks (`PI_REVIEW_ATTACH_CHARS=64000`) so finders do not spend extra round trips re-reading files.
3. **Verify** (default on; `PI_REVIEW_VERIFY=0` opts out): An adversarial subagent re-traces candidates against the repo, rejecting findings that lack evidence or fail mechanism checks.
4. **Report**: Deduplicates findings, orders by severity, and posts a markdown report. Results persist to `<repo>/.pi/review-state.json` so repeat reviews skip resolved findings.

**Triage, not a fix-all queue:** Fix valid critical/important issues introduced by the change. Suggestions are nonblocking, must identify concrete problems rather than optional polish, and may be declined with a brief reason even when valid. Normally use one initial review and at most one follow-up, only for substantive fixes — not to clear suggestions or reach zero findings. Re-run required checks after fixes; surface unresolved blockers rather than declaring completion. Persisted findings are reviewer context, not a mandatory backlog; a declined suggestion may repeat without requiring a fix or another review.

### Usage and Options

- Command: `/review [target] [--cwd <dir>] [--model <m>] [--verify-model <m>]`
- Target defaults to unpushed commits and uncommitted/untracked changes; can target `staged`, `tree`, a branch name, or a revision range.
- Non-git trees: a directory without `.git` is reviewed as its whole tree (no target or `tree`) — every eligible file enters as a synthetic new-file diff, through the same guarded reads and exclusion list as untracked files. Credential-shaped files (`.env*`, `*.pem`, `id_rsa`, …) are skipped and named in the notes — a plain tree has no .gitignore to do it — as are symlinks (not followed). An unreadable root fails loudly; nested unreadable directories are skipped and named, while systemic IO failures abort the review. Git-only targets (`staged`, refs, ranges) fail with a pointer to whole-tree mode. The walk is capped (5k files, 50k visited entries, 10k entries per directory) and honors abort mid-walk; the section shares the `PI_REVIEW_UNTRACKED_MAX_BYTES` budget (default 256KB — raise it for large tree reviews).
- Reviewing another project: `--cwd <dir>` (or a path-shaped target like `~/Code/foo`) reviews that directory instead of the session cwd — finder and verifier agents run inside the reviewed repo, and the report and priors land in its `.pi/`. The agent-facing `review` tool takes the same directory as its `cwd` parameter. Repo-controlled inputs (guidelines, priors, untracked files, attachments) are read through anchored, size-bounded, symlink-refusing guards; the check command is the explicit opt-in boundary. Residual risk: the review children read files by absolute path and their tasks quote repo text (the diff, `REVIEW.md`, `AGENTS.md`), so reviewing a foreign repo means trusting it not to prompt-inject — the same trust as opening it in an editor, not a sandbox.
- Default finder model is `opencode-go/muse-spark-1.3-contributor:off` — the value pick: ~69% recall (67.7%/71.0% across two 10-PR runs) at $0.007/PR and ~29s/PR (seed 42, judge `glm-5.3:off`, end-to-end with verification, `diffOnly` protocol since 2026-11). For maximum recall, `PI_REVIEW_MODEL=opencode-go/deepseek-v4.1-flash:off` measures 80.6% at $0.047/PR and ~5min/PR. Re-run with `npm run eval:review`.
- `PI_REVIEW_DIFF_ONLY=1` reviews a diff with no repository tree (the eval's fixture world, or a bare patch): finder and verifier prompts say no tree exists instead of asserting one the children cannot open. That lie measurably silenced substantiation-obedient models — `openai/gpt-6-luna` returned `[]` on 7/10 eval PRs while grepping for exactly the right guards (6.5% recall), then scored 45–58% across two runs the moment the prompt disclosed the world; deepseek moved 74.2% → 80.6%. Eval runs before the disclosure (`meta.diffOnly` absent/false) are not comparable to runs after it.
- gpt-6-luna thinking-effort sweep on the same sample (two 10-PR runs per arm): provider-default effort 45–58% recall, `:off` 42–48%, explicit `:low` 29–42%, explicit `:medium` 35–39% — run it plain; explicit reasoning effort hurts (default vs `:off` is within run noise), and run-to-run variance of ±13 points is normal for it. No reasoning-token breakdown is reported at any setting, so the mechanism is unverified; the ordering is consistent across all eight runs.
- muse-spark-1.3-contributor `:off` re-measured under the disclosed protocol: 67.7%/71.0% across two runs (~69% mean, ±1.7 variance) at $0.007/PR and ~29s/PR — the earlier write-off ("2× tokens, 4× wall") was the thinking-on arm; `:off` is cheap-tier. It fills the gap between deepseek (80.6%, $0.047/PR) and luna (~52%, $0.006/PR) at luna-class cost. muse-1.2 `:off` 64.5% is pre-disclosure and not comparable.
- Tool integration: Agents can execute the pipeline themselves via the `review` tool before committing changes.
- Pre-commit check integration: `PI_REVIEW_CHECK_CMD` (e.g. `npm run check`) runs a check command and feeds its output into the verification stage. When reviewing a directory other than the session cwd the command is skipped unless `PI_REVIEW_CHECK_FOREIGN=1` — a foreign repo's scripts are untrusted.

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

The extension queries `<baseUrl>/models` and mirrors discovered models into pi's `~/.pi/agent/models.json`, ensuring headless and subagent runs can resolve them. Subagents can also load the extension directly (`extensions: [openai-gateways]` in the agent file, or `PI_SUBAGENT_EXTENSIONS`) — the child then discovers the live catalog itself instead of relying on the mirror.

## Configuration

Configuration is managed via environment variables. Invalid values fall back to safe documented defaults:

| Extension   | Settings and Knobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagents` | `PI_SUBAGENT_TIMEOUT_MS` (default 20m), `PI_SUBAGENT_BIN` (child binary override; defaults to parent binary), `PI_SUBAGENT_IDLE_TIMEOUT_MS=300000` (5m LLM watchdog; `0` disables), `PI_SUBAGENT_CONCURRENCY=4`, `PI_SUBAGENT_BG_AFTER_MS` (auto-backgrounding threshold; `off` = never, the default), `PI_BASH_BG_AFTER_MS=300000` (5m `auto` window — the default wait mode for `bash`/`ssh_bash`; `off` restores block-until-finish), `PI_BG_WAKE=0` (suppress wake messages), `PI_BG_BASH_PERSIST=1` (background bash commands survive restarts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `recall`    | `PI_RECALL_SCOPE=session` (`project` includes sibling sessions), `PI_RECALL_EMBED=0` (disable embeddings), `PI_RECALL_WORKER_BIN` (embed worker interpreter: node ≥ 22.18 or bun), `PI_RECALL_COMPACT_TARGET=256000` (token cap for every model — back to the 256k ceiling after the 128k/100k targets cost more in agent continuity than the context they saved; `0` disables), `PI_RECALL_COMPACT_RATIO=0.7`, `PI_RECALL_COMPACT_IDLE_DISCOUNT=0.1` (idle early-fire this fraction of the target below it — 230.4k at the 256k target; `0` disables early fire), `PI_RECALL_SUMMARY_CACHE=0` (disable KV prompt cache reuse), `PI_RECALL_COMPACT_OWN=0` (use pi's default summaries), `PI_RECALL_SUMMARY_CHARS=5000`, `PI_RECALL_SUMMARY_THINKING=off` (one-off layout only — cached-layout summaries mirror the session's level so the replayed prefix renders identically), `PI_RECALL_DEBUG_PREFIX=1` (dump the cached-layout summary payload paired with the last live payload as `<sessionDir>/recall-debug/<sessionId>-diff.json` for first-divergence diffing; the dump is the full unredacted transcript — treat it as secret-bearing and delete after diagnosis) |
| `goal`      | `PI_GOAL_MAX_CONTINUATIONS=25`, `PI_GOAL_MAX_PIVOTS=1` (procedural reframes; `0` disables), `PI_GOAL_MAX_TURNS_PER_RUN=50`, `PI_GOAL_VERIFY_TIMEOUT_MS=900000` (15m), `PI_GOAL_CHECK_EVERY` (throttle verify runs to every Nth continuation), `PI_GOAL_JUDGE=0` (disable settle judge), `PI_GOAL_JUDGE_MODEL` (pin judge model), `PI_GOAL_JUDGE_TIMEOUT_MS=180000` (3m)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sshbash`   | `PI_SSH_IDLE_SECS=600` (OpenSSH control master idle timeout), `PI_SSH_CONNECT_TIMEOUT=15` (connection establishment timeout), `PI_SSH_STRICT_HOST_KEY=accept-new` (TOFU policy; accepts `yes`, `no`, `ask`, `off`, `accept-new`). Also honors `PI_BASH_BG_AFTER_MS` and `PI_BG_WAKE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `review`    | `PI_REVIEW_MODEL` (default `opencode-go/muse-spark-1.3-contributor:off`), `PI_REVIEW_VERIFY_MODEL`, `PI_REVIEW_CHUNK_CHARS=96000`, `PI_REVIEW_ATTACH_CHARS=64000`, `PI_REVIEW_MAX_CHILDREN=8`, `PI_REVIEW_CONCURRENCY=8`, `PI_REVIEW_TIMEOUT_MS`, `PI_REVIEW_IDLE_TIMEOUT_MS=300000`, `PI_REVIEW_CHECK_CMD` (read-only verification check command), `PI_REVIEW_MAX_FINDINGS=25`, `PI_REVIEW_PRIOR_CHARS=8000`, `PI_REVIEW_STATE=0` (disable persistence), `PI_REVIEW_VERIFY=0` (disable verification pass), `PI_REVIEW_DIFF_ONLY=1` (no repo tree: prompts disclose it instead of asserting one)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `superedit` | `PI_SUPEREDIT=0` (fall back to pi's built-in `edit`), `PI_SUPEREDIT_ALL_CAP=20` (max replacements for `occurrence: "all"`; clamped to 1000), `PI_SUPEREDIT_SYNTAX=0` (disable the post-edit tree-sitter syntax check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pushover`  | `PI_PUSHOVER_TOKEN` and `PI_PUSHOVER_USER` (both required; unconfigured extension remains completely inert)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
